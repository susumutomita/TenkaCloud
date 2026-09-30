import { runUptimeFlatKind } from "../../infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-flat";
import { resolveEndpoints } from "../../infrastructure/lib/problem-deploy/handlers/problem-endpoints-handler/resolve";
import type { ProbeFn } from "../../infrastructure/lib/problem-deploy/runtime-clients/http-probe-client";
import { type StackUnit, type UptimeStackDefinition, unitOf } from "./cloudformation-engine";
import {
  gate,
  HostError,
  type HostedEvent,
  type Job,
  type Team,
  type UptimeObservation,
  type UptimeOverride,
  type UptimeState,
} from "./model";
import type { HostProgression } from "./progression";
import { probePublicEndpoint, publicEndpointUrl } from "./public-probe";
import { projectedScore } from "./score";
import { digest, type HostStore } from "./store";

interface DisruptionHook {
  captureTriggers(event: HostedEvent): void;
}

interface Hooks {
  readonly progression: HostProgression;
  readonly disruptions: DisruptionHook;
}

interface Snapshot {
  readonly jobId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly problemId: string;
  readonly minute: number;
  readonly generation: string;
  readonly revision: number;
  readonly definition: UptimeStackDefinition;
  readonly definitionBody: string;
  readonly unit: StackUnit;
  readonly overrides: readonly { slot: string; overrideUrl: string }[];
  readonly state: UptimeState;
}

function uptimeDefinition(job: Job): UptimeStackDefinition | undefined {
  if (job.status !== "COMPLETE" || !job.unit || !job.deployedAt) return undefined;
  const definition = JSON.parse(job.definition) as UptimeStackDefinition;
  return definition.kind === "cloudformation" && definition.scoring.kind === "uptime-flat"
    ? definition
    : undefined;
}

export function uptimeGeneration(job: Job): string {
  return `${job.jobId}:${job.deployedAt}:${digest(job.unit ?? "")}`;
}

function hostHintUrls(unit: StackUnit): readonly [string, string] | undefined {
  const hint = unit.outputs?.Ec2HostHint;
  if (!hint || /[/:?#@]/u.test(hint)) return undefined;
  const frontend = `http://${hint}/`;
  const api = `http://${hint}:8080/healthz`;
  return publicEndpointUrl(frontend) && publicEndpointUrl(api) ? [frontend, api] : undefined;
}

function hostEndpoints(
  job: Job,
  definition: UptimeStackDefinition,
  overrides: readonly UptimeOverride[],
): ReturnType<typeof resolveEndpoints> {
  return resolveEndpoints({
    slots: definition.endpoints,
    stackOutputs: JSON.stringify(unitOf(job).outputs ?? {}),
    overrides: overrides.map((override) => ({
      ...override,
      tenantId: "local-host",
      teamId: job.teamId,
      problemId: job.problemId,
    })),
  });
}

/** Participant endpoint registry and one-current-minute, durable Battle scoring. */
export class LocalUptime {
  constructor(
    private readonly store: HostStore,
    private readonly now: () => number,
    private readonly serial: <T>(eventId: string, action: () => Promise<T> | T) => Promise<T>,
    private readonly hooks: () => Hooks,
    private readonly probe: ProbeFn = probePublicEndpoint,
    private readonly log: (message: string) => void = console.error,
  ) {}

  view(
    team: Team,
    problemId: string,
  ): { teamId: string; endpoints: ReturnType<typeof resolveEndpoints> } {
    this.hooks().progression.assertAccess(team, problemId);
    const job = this.authorizedJob(team, problemId);
    const definition = uptimeDefinition(job);
    if (!definition)
      throw new HostError(404, "This problem has no endpoint registry.", "no_endpoints");
    return {
      teamId: team.teamId,
      endpoints: hostEndpoints(
        job,
        definition,
        this.store.uptimeOverrides(team.eventId, team.teamId, problemId),
      ),
    };
  }

  change(team: Team, problemId: string, slot: string, method: "POST" | "DELETE", value?: unknown) {
    this.hooks().progression.assertAccess(team, problemId);
    const job = this.authorizedJob(team, problemId);
    const definition = uptimeDefinition(job);
    if (!definition)
      throw new HostError(404, "This problem has no endpoint registry.", "no_endpoints");
    const slotDefinition = definition.endpoints.find((entry) => entry.slot === slot);
    if (!slotDefinition) throw new HostError(404, "Unknown endpoint slot.", "unknown_slot");
    if (!slotDefinition.overridable && method === "POST")
      throw new HostError(409, "This endpoint cannot be overridden.", "slot_not_overridable");
    if (method === "POST" && !publicEndpointUrl(value))
      throw new HostError(400, "A public HTTP(S) URL is required.", "invalid_url");
    const event = this.store.event(team.eventId);
    if (gate(event, this.now()).kind !== "ok")
      throw new HostError(409, "Scoring is not active.", "scoring_not_active");
    if (!this.hooks().progression.allowed(team, problemId))
      throw new HostError(
        409,
        "A prerequisite challenge is not complete.",
        "challenge_prerequisite_not_met",
      );
    this.store.transaction(() => {
      if (method === "POST") {
        this.store.putUptimeOverride(team.eventId, team.teamId, problemId, {
          slot,
          overrideUrl: (value as string).trim(),
          updatedAt: new Date(this.now()).toISOString(),
        });
      } else {
        this.store.deleteUptimeOverride(team.eventId, team.teamId, problemId, slot);
      }
      const state = this.store.uptimeState(team.eventId, team.teamId, problemId);
      this.store.putUptimeState(team.eventId, team.teamId, problemId, {
        ...state,
        revision: state.revision + 1,
      });
    });
    return this.view(team, problemId);
  }

  private authorizedJob(team: Team, problemId: string): Job {
    const event = this.store.event(team.eventId);
    if (!event.problems.some((entry) => entry.problemId === problemId))
      throw new HostError(404, "Problem not found.");
    const jobId = this.store.jobId(team.eventId, team.teamId, problemId);
    if (!jobId) throw new HostError(404, "Deployment not found.");
    return this.store.job(jobId);
  }

  /** No catch-up: a tick only claims its current minute and discards probes crossing a boundary. */
  async tick(): Promise<void> {
    const minute = Math.floor(this.now() / 60_000);
    const candidates = this.store.jobs();
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, candidates.length) }, async () => {
        while (index < candidates.length) {
          const job = candidates[index++];
          if (!job) break;
          try {
            const snapshot = this.snapshot(job, minute);
            if (snapshot) await this.probeAndCommit(snapshot);
          } catch (error) {
            // The next scheduler pass may retry this minute; leave a visible diagnostic.
            this.log(
              `Uptime tick for ${job.eventId}/${job.teamId}/${job.problemId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }),
    );
  }

  private snapshot(job: Job, minute: number): Snapshot | undefined {
    const definition = uptimeDefinition(job);
    if (!definition) return undefined;
    const event = this.store.event(job.eventId);
    if (gate(event, this.now()).kind !== "ok") return undefined;
    const team = this.store.team(job.teamId);
    if (!this.hooks().progression.allowed(team, job.problemId)) return undefined;
    if (this.store.uptimeObserved(job.eventId, job.teamId, job.problemId, minute)) return undefined;
    const unit = unitOf(job);
    if (!hostHintUrls(unit)) return undefined;
    const overrides = this.store.uptimeOverrides(job.eventId, job.teamId, job.problemId);
    const endpoints = hostEndpoints(job, definition, overrides);
    // The Battle's two explicit participant registrations are a precondition, even when a
    // CloudFormation output later gains a default value.
    if (endpoints.length !== 2 || endpoints.some((endpoint) => !endpoint.overrideUrl))
      return undefined;
    const state = this.store.uptimeState(job.eventId, job.teamId, job.problemId);
    return {
      jobId: job.jobId,
      eventId: job.eventId,
      teamId: job.teamId,
      problemId: job.problemId,
      minute,
      generation: uptimeGeneration(job),
      revision: state.revision,
      definition,
      definitionBody: job.definition,
      unit,
      overrides,
      state,
    };
  }

  private async probeAndCommit(snapshot: Snapshot): Promise<void> {
    const urls = hostHintUrls(snapshot.unit);
    if (!urls) return;
    const [frontend, api] = await Promise.all(
      urls.map((url) => this.probe(url, { expectStatus: [200] })),
    );
    const nowIso = new Date(this.now()).toISOString();
    const hintHealth = {
      frontend: frontend?.ok === true,
      api: api?.ok === true,
      checkedAt: nowIso,
    };
    if (
      !(snapshot.state.generation === snapshot.generation && snapshot.state.readyAt) &&
      (!hintHealth.frontend || !hintHealth.api)
    ) {
      await this.serial(snapshot.eventId, () => {
        if (!this.current(snapshot)) return;
        this.store.transaction(() =>
          this.store.putUptimeState(snapshot.eventId, snapshot.teamId, snapshot.problemId, {
            ...snapshot.state,
            generation: snapshot.generation,
            hostHintHealth: hintHealth,
          }),
        );
      });
      return;
    }
    const result = await runUptimeFlatKind({
      deployment: {
        problemId: snapshot.problemId,
        stackOutputs: JSON.stringify(snapshot.unit.outputs ?? {}),
        endpointsHealth:
          snapshot.state.generation === snapshot.generation
            ? snapshot.state.endpointsHealth
            : undefined,
        lastResult:
          snapshot.state.generation === snapshot.generation ? snapshot.state.lastResult : undefined,
      },
      scoring: snapshot.definition.scoring,
      slots: snapshot.definition.endpoints,
      overrides: snapshot.overrides,
      phases: [],
      nowMs: this.now(),
      nowIso,
      prevState: {},
      probe: this.probe,
    });
    if (!result.endpointsHealthJson) return;
    // The event's scoring contract uses the two registered endpoints. The fixed EC2 host
    // establishes initial readiness and remains an independent recovery-health observation.
    const endpointsHealth = result.endpointsHealthJson;
    const healthy = result.lastResult === "ok";
    const scoreDelta = result.scoreDelta;
    await this.serial(snapshot.eventId, () => {
      if (!this.current(snapshot)) return;
      this.store.transaction(() => {
        if (!this.current(snapshot)) return;
        const team = this.store.team(snapshot.teamId);
        const event = this.store.event(snapshot.eventId);
        const scoreEvents = [
          {
            jobId: snapshot.jobId,
            problemId: snapshot.problemId,
            source: "uptime",
            points: scoreDelta,
            result: healthy ? ("ok" as const) : ("wrong" as const),
            occurredAt: nowIso,
          },
          ...team.scoreEvents,
        ];
        const updatedTeam: Team = {
          ...team,
          score: projectedScore(event, scoreEvents).total,
          scoreEvents,
        };
        const nextState: UptimeState = {
          ...snapshot.state,
          generation: snapshot.generation,
          readyAt:
            snapshot.state.generation === snapshot.generation && snapshot.state.readyAt
              ? snapshot.state.readyAt
              : this.now(),
          endpointsHealth,
          lastResult: healthy ? "ok" : "fail",
          hostHintHealth: hintHealth,
        };
        const observation: UptimeObservation = {
          eventId: snapshot.eventId,
          teamId: snapshot.teamId,
          problemId: snapshot.problemId,
          minute: snapshot.minute,
          generation: snapshot.generation,
          checkedAt: nowIso,
          scoreDelta,
          endpointsHealth,
          hostHintHealth: hintHealth,
        };
        this.store.putTeam(updatedTeam);
        this.store.putUptimeState(snapshot.eventId, snapshot.teamId, snapshot.problemId, nextState);
        this.store.putUptimeObservation(observation);
        this.hooks().progression.captureTeam(updatedTeam);
        this.hooks().disruptions.captureTriggers(event);
      });
    });
  }

  private current(snapshot: Snapshot): boolean {
    if (Math.floor(this.now() / 60_000) !== snapshot.minute) return false;
    const event = this.store.event(snapshot.eventId);
    if (gate(event, this.now()).kind !== "ok") return false;
    const team = this.store.team(snapshot.teamId);
    if (!this.hooks().progression.allowed(team, snapshot.problemId)) return false;
    const jobId = this.store.jobId(snapshot.eventId, snapshot.teamId, snapshot.problemId);
    if (!jobId) return false;
    const job = this.store.job(jobId);
    if (
      uptimeGeneration(job) !== snapshot.generation ||
      job.status !== "COMPLETE" ||
      job.definition !== snapshot.definitionBody
    )
      return false;
    const state = this.store.uptimeState(snapshot.eventId, snapshot.teamId, snapshot.problemId);
    return (
      state.revision === snapshot.revision &&
      !this.store.uptimeObserved(
        snapshot.eventId,
        snapshot.teamId,
        snapshot.problemId,
        snapshot.minute,
      )
    );
  }
}
