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
  status: "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "DELETING" | "DELETED";
  /** Committed before a runtime can be created; retained until physical cleanup succeeds. */
  unit: string | null;
  error?: string;
}

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
  stop(job: Job): Promise<void>;
  view(context: Context): Promise<Record<string, unknown>>;
  submit(context: Context, body: Record<string, unknown>): Promise<EngineResult>;
  hint(context: Context, problemId: string, hintId: string): Promise<EngineResult>;
  surface(job: Job): string;
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

export function gate(event: HostedEvent, now: number): Gate {
  if (
    ["ENDED", "TEARDOWN", "ARCHIVED"].includes(event.status) ||
    (event.endsAt && Date.parse(event.endsAt) <= now)
  ) {
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
