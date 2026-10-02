import { z } from "zod";
import { digestSchema, hash, id, matchSchema } from "./coordination-state.js";
import {
  COORDINATION_MAX_BYTES,
  coordinationHeadKey,
  NativeCoordinationError,
  type NativeCoordinationRun,
} from "./domain/coordination.js";
import type { CoordinationTiming } from "./dynamodb-deployments-coordination.js";
import { sqlPayload } from "./sql-cloud-records.js";
import type { SqlExecutor, SqlStatement } from "./sql-port.js";
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
    .max(48),
  clock: z.object({
    pausedMs: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    lockedAt: z.number().optional(),
  }),
  closed: z.boolean(),
  admissionOwner: z.string().uuid().optional(),
  admissionExpiresAt: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
  snapshotDigest: digestSchema,
  byteLength: z.number().int().positive().max(COORDINATION_MAX_BYTES),
  chunkCount: z.literal(1),
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
  const head = headSchema.parse(sqlPayload(raw));
  assertSnapshotScope(head, eventId, problemId);
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
        AND json_extract(payload, '$.closed') = ?)`,
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
}

/** Teardown verifies the complete closed snapshot and fences the exact verified revision. */
export async function sqlCloseFence(
  sql: SqlExecutor,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<SqlStatement[]> {
  const run = await readSqlSnapshot(sql, eventId, problemId, timing);
  if (!run) return [sqlHeadAbsent(eventId, problemId)];
  if (!run.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
  return [sqlHeadCheck(run)];
}
