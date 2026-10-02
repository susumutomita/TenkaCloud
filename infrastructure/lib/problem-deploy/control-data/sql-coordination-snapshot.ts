import { z } from "zod";
import { assertPurgeManifest, purgeSchema } from "./coordination-purge.js";
import { digestSchema, hash, id, matchSchema } from "./coordination-state.js";
import {
  coordinationHeadKey,
  NativeCoordinationError,
  type NativeCoordinationRun,
  type NativeCoordinationSummary,
  SQL_COORDINATION_MAX_BYTES,
} from "./domain/coordination.js";
import { SQL_EVENT_LIMITS } from "./domain/events.js";
import type { CoordinationTiming } from "./dynamodb-deployments-coordination.js";
import { sqlPayload } from "./sql-cloud-records.js";
import type { SqlExecutor, SqlRow, SqlStatement } from "./sql-port.js";
import { sqlGuard } from "./sql-transaction.js";

export const headSchema = z.object({
  eventId: id,
  problemId: z.literal("ac26-crypto-battle"),
  runId: id,
  revision: z.number().int().nonnegative(),
  artifactDigest: digestSchema,
  pluginKey: z.string(),
  catalogKey: z.string(),
  roster: z
    .array(z.object({ teamId: id, teamName: z.string() }))
    .min(1)
    .max(SQL_EVENT_LIMITS.maxTeams),
  clock: z.object({
    pausedMs: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    lockedAt: z.number().optional(),
  }),
  closed: z.boolean(),
  history: z.array(id).max(2).optional(),
  retiredRuns: z.array(id).max(1).optional(),
  snapshotLayout: z.literal("run").optional(),
  admissionOwner: z.string().uuid().optional(),
  admissionExpiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
  snapshotDigest: digestSchema,
  byteLength: z.number().int().positive().max(SQL_COORDINATION_MAX_BYTES),
  chunkCount: z.literal(1),
  purge: purgeSchema.optional(),
});

export interface StoredRun extends NativeCoordinationRun {
  readonly admissionOwner?: string;
  readonly admissionExpiresAt?: number;
  readonly snapshotDigest: string;
  readonly chunkCount: number;
  readonly byteLength: number;
}
export async function readSqlSnapshot(
  sql: SqlExecutor,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<StoredRun | undefined> {
  coordinationHeadKey(eventId, problemId);
  const raw = await sql.get(
    "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
    [eventId, problemId],
  );
  if (!raw) return undefined;
  return decodeSqlSnapshot(raw, eventId, problemId, timing);
}

/** The current head authorizes retained history in the same primary read snapshot. */
export async function readSqlRunSnapshot(
  sql: SqlExecutor,
  eventId: string,
  problemId: string,
  runId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<StoredRun | undefined> {
  coordinationHeadKey(eventId, problemId);
  id.parse(runId);
  const raw = await sql.get(
    `SELECT head.payload AS head_payload,
      CASE WHEN json_extract(head.payload, '$.runId') = ? THEN head.payload ELSE history.payload END AS payload,
      CASE WHEN json_extract(head.payload, '$.runId') = ? THEN head.snapshot ELSE history.snapshot END AS snapshot
      FROM cloud_coordination_runs AS head
      LEFT JOIN cloud_coordination_history AS history
        ON history.event_id = head.event_id AND history.problem_id = head.problem_id AND history.run_id = ?
      WHERE head.event_id = ? AND head.problem_id = ?`,
    [runId, runId, runId, eventId, problemId],
  );
  if (!raw) return undefined;
  if (typeof raw.head_payload !== "string")
    throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
  const head = headSchema.parse(JSON.parse(raw.head_payload) as unknown);
  assertSnapshotScope(head, eventId, problemId);
  assertSqlPayloadAvailable(head);
  if (head.runId !== runId) {
    if (!head.history?.includes(runId)) return undefined;
    if (typeof raw.payload !== "string" || typeof raw.snapshot !== "string")
      throw new NativeCoordinationError(503, "coordination_history_invalid");
  }
  const run = decodeSqlSnapshot(raw, eventId, problemId, timing);
  if (run.runId !== runId) throw new NativeCoordinationError(503, "coordination_scope_invalid");
  return run;
}

export function decodeSqlSnapshot(
  raw: SqlRow,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): StoredRun {
  const head = headSchema.parse(sqlPayload(raw));
  assertSnapshotScope(head, eventId, problemId);
  assertSqlPayloadAvailable(head);
  if (typeof raw.snapshot !== "string")
    throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
  const bytes = Buffer.from(raw.snapshot, "utf8");
  if (bytes.byteLength !== head.byteLength || hash(bytes) !== head.snapshotDigest)
    throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
  const start = performance.now();
  try {
    const parsed = matchSchema.parse(JSON.parse(raw.snapshot as string) as unknown);
    if (parsed.version !== head.revision)
      throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
    return { ...head, match: { ...parsed, state: parsed.state } };
  } finally {
    timing?.({ phase: "decode", elapsedMs: performance.now() - start });
  }
}

export function sqlHeadCheck(run: StoredRun): SqlStatement {
  return sqlGuard(
    `EXISTS (SELECT 1 FROM cloud_coordination_runs
      WHERE event_id = ? AND problem_id = ? AND json_extract(payload, '$.runId') = ?
        AND json_extract(payload, '$.revision') = ? AND json_extract(payload, '$.snapshotDigest') = ?
        AND json_extract(payload, '$.closed') = ? AND json_extract(payload, '$.purge') IS NULL)`,
    [run.eventId, run.problemId, run.runId, run.revision, run.snapshotDigest, Number(run.closed)],
  );
}
export function sqlHeadAbsent(eventId: string, problemId: string): SqlStatement {
  coordinationHeadKey(eventId, problemId);
  return sqlGuard(
    "NOT EXISTS (SELECT 1 FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?)",
    [eventId, problemId],
  );
}

export function assertSnapshotScope(
  head: z.infer<typeof headSchema>,
  eventId: string,
  problemId: string,
): void {
  if (head.eventId !== eventId || head.problemId !== problemId)
    throw new NativeCoordinationError(503, "coordination_scope_invalid");
  assertPurgeManifest(head);
  if (head.purge && (head.admissionOwner !== undefined || head.admissionExpiresAt !== undefined))
    throw new NativeCoordinationError(503, "coordination_purge_invalid");
}

/** The permanent manifest authorizes summaries and cleanup, never private state reads. */
export function assertSqlPayloadAvailable(head: z.infer<typeof headSchema>): void {
  if (head.purge) throw new NativeCoordinationError(409, "coordination_run_closed");
}

export async function readSqlSummary(
  sql: SqlExecutor,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<NativeCoordinationSummary | undefined> {
  coordinationHeadKey(eventId, problemId);
  const raw = await sql.get(
    "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
    [eventId, problemId],
  );
  if (!raw) return undefined;
  const head = headSchema.parse(sqlPayload(raw));
  assertSnapshotScope(head, eventId, problemId);
  if (!head.purge) decodeSqlSnapshot(raw, eventId, problemId, timing);
  else if (head.purge.state === "complete" && raw.snapshot !== "")
    throw new NativeCoordinationError(503, "coordination_purge_invalid");
  return {
    eventId,
    problemId,
    runId: head.runId,
    revision: head.revision,
    closed: head.closed,
    ...(head.purge ? { purgeState: head.purge.state } : {}),
  };
}

/** Teardown verifies the complete closed snapshot and fences the exact verified revision. */
export async function sqlCloseFence(
  sql: SqlExecutor,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<SqlStatement[]> {
  coordinationHeadKey(eventId, problemId);
  const raw = await sql.get(
    "SELECT payload, snapshot FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?",
    [eventId, problemId],
  );
  if (!raw) return [sqlHeadAbsent(eventId, problemId)];
  const head = headSchema.parse(sqlPayload(raw));
  assertSnapshotScope(head, eventId, problemId);
  if (head.purge?.state === "pending")
    throw new NativeCoordinationError(503, "coordination_purge_pending");
  if (head.purge?.state === "complete") {
    if (raw.snapshot !== "") throw new NativeCoordinationError(503, "coordination_purge_invalid");
    return [
      sqlGuard(
        `EXISTS (SELECT 1 FROM cloud_coordination_runs WHERE event_id = ? AND problem_id = ?
          AND payload = ? AND snapshot = '' AND json_extract(payload, '$.purge.state') = 'complete')`,
        [eventId, problemId, String(raw.payload)],
      ),
    ];
  }
  const run = decodeSqlSnapshot(raw, eventId, problemId, timing);
  if (!run.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
  return [sqlHeadCheck(run)];
}
