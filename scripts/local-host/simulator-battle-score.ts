import { z } from "zod";
import { parseScoringMetadata } from "../../packages/problem-sdk/src/scoring-metadata";
import { computeSince, parseEndpointsHealth } from "../lib/endpoints-health";
import type { directWebTransport } from "./direct-web-transport";
import { gate, type Team, type UptimeObservation, type UptimeState } from "./model";
import { projectedScore } from "./score";
import { authenticateBattleProbeDescriptor } from "./simulator-battle-probe";
import { type BattleProbeRecord, SimulatorBattleProbeStore } from "./simulator-battle-probe-store";
import type { BattleRegistrationGate } from "./simulator-battle-registration";
import { SimulatorBattleRegistrationStore } from "./simulator-battle-registration-store";
import { simulatorBattleUptimeTarget } from "./simulator-battle-uptime-target";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";
import type { HostStore } from "./store";

interface Context {
  host: HostStore;
  settings: SimulatorSettings;
  clock: OwnedSimulatorClock;
  signal: AbortSignal;
  /** Trusted synchronous authorization/progression gate, reread inside commit. */
  current(): BattleRegistrationGate;
  wallNow(): number;
  /** Existing progression/disruption DB hooks, synchronous and on this HostStore. */
  afterCommit(team: Team): void;
}

/** Private owned-session composition only. No dispatch, retry, deadline rebasing or
 * catch-up. Both settled slots are reauthenticated before an atomic score commit.
 * This helper does not by itself enable the participant API or scheduler. */
export async function scoreSettledBattleMinute(
  context: Context,
  minute: number,
  dependencies: { transport?: typeof directWebTransport; now?: () => number } = {},
): Promise<UptimeObservation | undefined> {
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(minute);
  const { host, clock, signal } = context;
  const probes = new SimulatorBattleProbeStore(host, { kind: "owned-battle-probe-journal" });
  const registrations = new SimulatorBattleRegistrationStore(host, {
    kind: "owned-battle-registration-scope",
    providerDomain: clock.domain,
  });
  const capture = (now: number) => {
    signal.throwIfAborted();
    const authorization = context.current();
    const { target, revision } = authorization;
    const { eventId, teamId, jobId } = target.owner;
    const job = host.job(jobId);
    const event = host.event(eventId);
    const current = simulatorBattleUptimeTarget(job);
    const state = host.uptimeState(eventId, teamId, target.problemId);
    if (
      JSON.stringify(current) !== JSON.stringify(target) ||
      host.jobId(eventId, teamId, target.problemId) !== jobId ||
      state.revision !== revision ||
      Math.floor(now / 60_000) !== minute ||
      gate(event, now).kind !== "ok" ||
      !event.problems.some(
        (p) => p.problemId === target.problemId && p.definition === job.definition,
      ) ||
      host.uptimeObserved(eventId, teamId, target.problemId, minute)
    )
      throw new Error("Battle scoring authorization changed or minute already consumed.");
    const pair = (["frontend", "api"] as const).map((slot) => {
      const registration = registrations.get(target, slot);
      const record = probes.forMinute(eventId, teamId, slot, minute);
      if (
        !registration ||
        !record ||
        record.state !== "settled" ||
        !record.snapshot?.settled ||
        record.authorizationRevision !== revision ||
        record.descriptor.generation !== target.generation ||
        JSON.stringify(record.descriptor.owner) !== JSON.stringify(target.owner) ||
        record.descriptor.deadline.domain !== clock.domain
      )
        throw new Error("Battle minute lacks a current registered settled pair.");
      return { registration, record };
    });
    if (
      JSON.stringify(pair[0]?.record.descriptor.receipt) !==
      JSON.stringify(pair[1]?.record.descriptor.receipt)
    )
      throw new Error("Battle slot receipts differ.");
    return { authorization, definition: job.definition, state, pair };
  };
  const before = capture(context.wallNow());
  await Promise.all(
    before.pair.map(({ record }) =>
      authenticateBattleProbeDescriptor(context.settings, clock, record.descriptor, dependencies),
    ),
  );
  return host.transaction(() => {
    const now = context.wallNow();
    const after = capture(now);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Battle scoring changed during authentication.");
    const { target } = after.authorization;
    const { eventId, teamId, jobId } = target.owner;
    const { state, healthy, readyAt, scoreDelta, endpointsHealth, hintHealth, checkedAt } =
      minuteResult(
        after.definition,
        after.state,
        target.generation,
        after.pair.map(({ record }) => record),
        now,
      );
    if (!readyAt && !healthy) {
      host.putUptimeState(eventId, teamId, target.problemId, state);
      if (
        JSON.stringify(host.uptimeState(eventId, teamId, target.problemId)) !==
        JSON.stringify(state)
      )
        throw new Error("Battle readiness atomic verification failed.");
      return undefined;
    }
    const team = host.team(teamId);
    const scoreEvents = [
      {
        jobId,
        problemId: target.problemId,
        source: "uptime",
        points: scoreDelta,
        result: healthy ? ("ok" as const) : ("wrong" as const),
        occurredAt: checkedAt,
      },
      ...team.scoreEvents,
    ];
    const updated = {
      ...team,
      scoreEvents,
      score: projectedScore(host.event(eventId), scoreEvents).total,
    };
    const observation: UptimeObservation = {
      eventId,
      teamId,
      problemId: target.problemId,
      minute,
      generation: target.generation,
      checkedAt,
      scoreDelta,
      endpointsHealth,
      hostHintHealth: hintHealth,
    };
    host.putTeam(updated);
    host.putUptimeState(eventId, teamId, target.problemId, state);
    host.putUptimeObservation(observation);
    const statement = host.database.prepare(
      "SELECT body FROM host_uptime_observations WHERE event_id=? AND team_id=? AND problem_id=? AND minute=?",
    );
    try {
      const row = z
        .object({ body: z.string() })
        .parse(statement.get(eventId, teamId, target.problemId, minute));
      if (
        row.body !== JSON.stringify(observation) ||
        JSON.stringify(host.team(teamId)) !== JSON.stringify(updated) ||
        JSON.stringify(host.uptimeState(eventId, teamId, target.problemId)) !==
          JSON.stringify(state)
      )
        throw new Error("Battle score atomic verification failed.");
    } finally {
      statement.finalize?.();
    }
    context.afterCommit(updated);
    return observation;
  });
}

function settledHealth(
  records: readonly BattleProbeRecord[],
  scoring: import("../../packages/problem-sdk/src/scoring-metadata").UptimeFlatScoringMetadata,
  previous: ReturnType<typeof parseEndpointsHealth>,
  checkedAt: string,
) {
  const health: Record<string, { ok: boolean; checkedAt: string; since?: string }> = {};
  for (const record of records) {
    const slot = record.descriptor.slot;
    const matches = scoring.endpoints.filter((endpoint) => endpoint.slot === slot);
    const endpoint = matches[0];
    const result = record.snapshot?.result;
    if (
      matches.length !== 1 ||
      !endpoint ||
      endpoint.path !== record.descriptor.receipt.slots[slot].service.path
    )
      throw new Error("Battle probe differs from pinned scoring endpoint.");
    const ok =
      !!result &&
      "observation" in result &&
      (endpoint.expectStatus ?? [200]).includes(result.observation.status);
    const since = computeSince(ok, previous[slot], checkedAt);
    health[slot] = { ok, checkedAt, ...(since ? { since } : {}) };
  }
  return health;
}

function minuteResult(
  definition: string,
  prior: UptimeState,
  generation: string,
  records: readonly BattleProbeRecord[],
  now: number,
) {
  const scoring = parseScoringMetadata(JSON.parse(definition).scoring);
  if (scoring?.kind !== "uptime-flat" || scoring.endpoints.length !== 2)
    throw new Error("Unsupported Battle scoring contract.");
  const checkedAt = new Date(now).toISOString();
  const previous = parseEndpointsHealth(
    prior.generation === generation ? prior.endpointsHealth : undefined,
  );
  const health = settledHealth(records, scoring, previous, checkedAt);
  const healthy = Object.values(health).every((value) => value.ok);
  const readyAt = prior.generation === generation ? prior.readyAt : undefined;
  const scoreDelta = healthy ? scoring.pointsPerSuccess : (scoring.failurePenalty ?? 0);
  const endpointsHealth = JSON.stringify(health);
  const hintHealth = {
    frontend: health.frontend?.ok === true,
    api: health.api?.ok === true,
    checkedAt,
  };
  const state = {
    ...prior,
    readyAt,
    generation: generation,
    endpointsHealth,
    lastResult: healthy ? ("ok" as const) : ("fail" as const),
    hostHintHealth: hintHealth,
    ...(healthy ? { readyAt: readyAt ?? now } : {}),
  };
  return { state, healthy, readyAt, scoreDelta, endpointsHealth, hintHealth, checkedAt };
}
