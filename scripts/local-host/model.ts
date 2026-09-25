/** Local hosting's durable records. Private runtime descriptors never enter browser responses. */
type SqlBinding = string | number | null;

export interface SqlStatement {
  finalize?(): void;
  get(...values: SqlBinding[]): unknown;
  all(...values: SqlBinding[]): unknown[];
  run(...values: SqlBinding[]): unknown;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface Problem {
  problemId: string;
  name: string;
  definition: string;
}

export interface HostedEvent {
  eventId: string;
  name: string;
  status: "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  startsAt?: string;
  endsAt?: string;
  expiresAt: number;
  scoringLocked: boolean;
  scoringLockedAt?: string;
  scoreboardFreezeMinutes: number;
  problems: Problem[];
}

export interface ScoreEvent {
  jobId: string;
  problemId: string;
  source: string;
  points: number;
  result: "ok" | "wrong";
  occurredAt: string;
}

export interface Team {
  teamId: string;
  eventId: string;
  internalSlug: string;
  displayName: string;
  loginKey: string;
  snapshot: string | null;
  score: number;
  completedProblems: number;
  scoreEvents: ScoreEvent[];
}

export interface Job {
  jobId: string;
  eventId: string;
  teamId: string;
  problemId: string;
  definition: string;
  offset: number;
  /** `STOPPED`: the organizer halted this one environment; containers and data are kept. */
  status: "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "STOPPED" | "DELETING" | "DELETED";
  /** Committed before a runtime can be created; retained until physical cleanup succeeds. */
  unit: string | null;
  error?: string;
  /** An organizer operation on this single environment that has not finished yet. */
  operation?: JobOperation;
}

/** Organizer operations on one team/problem environment. */
export type JobOperation = "stop" | "restart" | "teardown";

export interface Context {
  event: HostedEvent;
  team: Team;
  jobs: Job[];
  now: number;
}

export interface EngineResult {
  status: number;
  body: Record<string, unknown>;
  snapshot: string;
  score: number;
  completedProblems: number;
  scoreEvents: ScoreEvent[];
}

export interface RuntimeEngine {
  catalog(): readonly Problem[];
  start(job: Job, retain: (unit: string | null) => void): Promise<void>;
  recover(job: Job): Promise<void>;
  /** Remove the environment's containers and volumes (teardown). */
  stop(job: Job): Promise<void>;
  /** Halt a running environment's containers, keeping them and their data. */
  pause(job: Job): Promise<void>;
  /** Restart a halted or running environment in place and wait until it is reachable. */
  resume(job: Job): Promise<void>;
  view(context: Context): Promise<Record<string, unknown>>;
  submit(context: Context, body: Record<string, unknown>): Promise<EngineResult>;
  hint(context: Context, problemId: string, hintId: string): Promise<EngineResult>;
  surface(job: Job): string;
  /** Host ports the problem would publish at `offset`, so a slot can be probed before use. */
  hostPorts?(definition: string, offset: number): readonly number[];
}

export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind = "request_failed",
  ) {
    super(message);
    this.name = "HostError";
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostError(400, "A JSON object is required.");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max = 120): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character < " ")
  ) {
    throw new HostError(400, `${label} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}

export type Gate =
  | { kind: "ok" }
  | {
      kind: "scoring_not_started";
      startsAt?: string;
    }
  | {
      kind: "scoring_ended";
      endsAt?: string;
    }
  | { kind: "scoring_locked" };

/** Scoring is over for good once an event ends, is torn down or is archived. */
export function scoringEnded(event: HostedEvent): boolean {
  return event.status === "ENDED" || event.status === "TEARDOWN" || event.status === "ARCHIVED";
}

/** True once the organizer actually started the event; a never-started event has no play. */
export function hasStarted(event: HostedEvent, now: number): boolean {
  return event.startsAt !== undefined && Date.parse(event.startsAt) <= now;
}

export function gate(event: HostedEvent, now: number): Gate {
  if (scoringEnded(event) || (event.endsAt && Date.parse(event.endsAt) <= now)) {
    return { kind: "scoring_ended", endsAt: event.endsAt };
  }
  if (event.status !== "READY" || !event.startsAt || Date.parse(event.startsAt) > now) {
    return { kind: "scoring_not_started", startsAt: event.startsAt };
  }
  return event.scoringLocked ? { kind: "scoring_locked" } : { kind: "ok" };
}

export function assertPlaying(event: HostedEvent, now: number): void {
  const result = gate(event, now);
  if (result.kind !== "ok") throw new HostError(409, result.kind, result.kind);
}
