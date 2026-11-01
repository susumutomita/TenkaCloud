import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostPlugin } from "../coordination-core";
import { type HttpHost, startHttpHost } from "../http";
import {
  type Context,
  definitionKind,
  type EngineResult,
  type Job,
  type Problem,
  type RuntimeEngine,
} from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { ExerciseFixture } from "./exercise-fixture";
import { HistoricalCompetitionEngine } from "./historical-competition-fixture";
import { organizerToken } from "./organizer-login";

export const GATE = "challengePrerequisiteGate";
export const START = Date.parse("2026-09-30T00:00:00Z");
/** The flag-and-hint exercise every gate test unlocks the Battle with. */
export const GATE_PROBLEM = "sqli-demo";
export interface CreatedEvent {
  eventId: string;
  teams: { teamId: string; teamLoginKey: string }[];
}

/**
 * Routes the Docker exercise to the test-only {@link ExerciseFixture} and the crypto Battle to the
 * real competition engine, so gate tests need neither Docker nor AWS.
 */
export class GateEngine implements RuntimeEngine {
  readonly exercise: ExerciseFixture;
  private readonly battle: HistoricalCompetitionEngine;
  private readonly problems: readonly Problem[];
  constructor(root: string, data: string) {
    this.exercise = new ExerciseFixture((path) => new Database(path));
    this.battle = new HistoricalCompetitionEngine(root, data, false);
    // A pinned floor keeps the exercise's wrong-answer debt from going below zero on its own.
    const exercise = this.exercise.catalog().map((problem) => ({
      ...problem,
      definition: JSON.stringify({ ...JSON.parse(problem.definition), scoreFloor: 0 }),
    }));
    this.problems = [...exercise, ...this.battle.catalog()];
  }
  catalog(): readonly Problem[] {
    return this.problems;
  }
  requiresGateway(): boolean {
    return false;
  }
  coordinationPlugin(problem: Problem): HostPlugin {
    return this.battle.coordinationPlugin(problem);
  }
  private engineFor(definition: string): RuntimeEngine {
    return definitionKind(definition) === "compose" ? this.exercise : this.battle;
  }
  private part(context: Context, exercise: boolean): Context {
    const own = (definition: string) => (definitionKind(definition) === "compose") === exercise;
    const problems = context.event.problems.filter((problem) => own(problem.definition));
    return {
      ...context,
      event: { ...context.event, problems },
      jobs: context.jobs.filter((job) => own(job.definition)),
    };
  }
  private exerciseProblem(context: Context, problemId: unknown): boolean {
    const problem = context.event.problems.find((each) => each.problemId === problemId);
    return problem !== undefined && definitionKind(problem.definition) === "compose";
  }
  start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    return this.engineFor(job.definition).start(job, retain);
  }
  recover(job: Job): Promise<void> {
    return this.engineFor(job.definition).recover(job);
  }
  stop(job: Job): Promise<void> {
    return this.engineFor(job.definition).stop(job);
  }
  pause(job: Job): Promise<void> {
    return this.engineFor(job.definition).pause(job);
  }
  resume(job: Job): Promise<void> {
    return this.engineFor(job.definition).resume(job);
  }
  surface(job: Job): string {
    return this.engineFor(job.definition).surface(job);
  }
  async view(context: Context): Promise<Record<string, unknown>> {
    const exercise = this.part(context, true);
    const battle = this.part(context, false);
    const views = await Promise.all([
      exercise.event.problems.length ? this.exercise.view(exercise) : { problems: [] },
      battle.event.problems.length ? this.battle.view(battle) : { problems: [] },
    ]);
    return { problems: views.flatMap((view) => view.problems as unknown[]) };
  }
  /** The exercise keeps the team's whole ledger, so Battle points survive its answers. */
  submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    return this.exerciseProblem(context, body.problemId)
      ? this.exercise.submit(this.part(context, true), body)
      : this.battle.submit(context, body);
  }
  hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    return this.exerciseProblem(context, problemId)
      ? this.exercise.hint(this.part(context, true), problemId, hintId)
      : this.battle.hint(context, problemId, hintId);
  }
}

/** Real host HTTP, SQLite, progression ledger and Battle plugin; only the exercise is synthetic. */
export async function progressionFixture() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const data = createTemporaryDirectory(root, "tenka-progression-");
  const filename = join(data, "host.sqlite");
  let store = new HostStore(new Database(filename));
  // Only the key's hash is stored, so the same key signs in again after a restart.
  const organizerKey = store.ensureLocalOrganizerKey().key;
  if (!organizerKey) throw new Error("A fresh store must issue an organizer key.");
  const engine = new GateEngine(root, data);
  let service = new HostingService(store, engine, "gate-test-host-key", () => START);
  let admin: HttpHost;
  let portal: HttpHost;
  let token = "";
  async function start() {
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: data,
      service,
    });
    admin = await startHttpHost({
      kind: "admin",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: data,
      service,
      participantOrigin: portal.origin,
    });
    token = await organizerToken({ admin: admin.origin, key: organizerKey ?? "" });
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    nonce?: string,
  ) {
    const response = await fetch(
      `${path.startsWith("/portal/") ? portal.origin : admin.origin}/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${key ?? token}`,
          "content-type": "application/json",
          ...(nonce ? { "idempotency-key": nonce } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function stop() {
    await Promise.all([admin.close(), portal.close()]);
    await service.drain();
    service.flush();
    store.close();
  }
  await start();
  return {
    root,
    data,
    engine,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    request,
    get adminToken() {
      return token;
    },
    get adminOrigin() {
      return admin.origin;
    },
    get participantOrigin() {
      return portal.origin;
    },
    async create(name = "gate test"): Promise<CreatedEvent> {
      const made = await request("/events", "POST", {
        name,
        teams: [
          { internalSlug: `alpha-${name.replaceAll(" ", "-")}` },
          { internalSlug: `beta-${name.replaceAll(" ", "-")}` },
        ],
        problems: [{ problemId: GATE_PROBLEM }, { problemId: "crypto-battle" }],
      });
      if (made.status !== 201) throw new Error(JSON.stringify(made));
      const event = made.body as unknown as CreatedEvent;
      await request(`/events/${event.eventId}/deploy`, "POST", {});
      await service.drain();
      await request(`/events/${event.eventId}/schedule`, "PATCH", { startNow: true });
      return event;
    },
    /** Solve the running exercise the way a participant does, through its login form. */
    async exerciseFlag(event: CreatedEvent, teamId: string): Promise<string> {
      const job = store
        .jobs(event.eventId, teamId)
        .find((candidate) => candidate.problemId === GATE_PROBLEM);
      if (!job) throw new Error("Missing exercise job");
      const response = await fetch(`${engine.exercise.surface(job)}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "admin' --", password: "" }).toString(),
      });
      const { flag } = (await response.json()) as { flag?: unknown };
      if (typeof flag !== "string") throw new Error("The exercise did not reveal its flag.");
      return flag;
    },
    flag(enabled: boolean) {
      return request("/feature-flags", "PUT", { key: GATE, enabled });
    },
    async restart() {
      await stop();
      store = new HostStore(new Database(filename));
      service = new HostingService(store, engine, "gate-test-host-key", () => START);
      await service.recover();
      await start();
    },
    async close() {
      await stop();
      await engine.exercise.close();
      removeTemporaryDirectory(root, data);
    },
  };
}
