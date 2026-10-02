import { type DynamoDBDocumentClient, GetCommand, TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { assertPurgeManifest, type PurgeManifest, purgeSchema } from "./coordination-purge.js";
import { digestSchema, hash, id, matchSchema } from "./coordination-state.js";
import type { Write } from "./deployment-storage.js";
import {
  COORDINATION_CHUNK_BYTES,
  COORDINATION_MAX_BYTES,
  coordinationHeadKey,
  NativeCoordinationError,
  type NativeCoordinationRun,
} from "./domain/coordination.js";
import { CLOUD_EVENT_LIMITS } from "./domain/events.js";
import type { CoordinationTiming } from "./dynamodb-deployments-coordination.js";

export const headSchema = z.object({
  eventId: id,
  problemId: z.literal("ac26-crypto-battle"),
  runId: id,
  revision: z.number().int().nonnegative(),
  history: z.array(id).max(2).optional(),
  retiredRuns: z.array(id).max(1).optional(),
  snapshotLayout: z.literal("run").optional(),
  artifactDigest: digestSchema,
  pluginKey: z.string(),
  catalogKey: z.string(),
  roster: z
    .array(z.object({ teamId: id, teamName: z.string() }))
    .min(1)
    .max(CLOUD_EVENT_LIMITS.maxTeams),
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
  chunkCount: z.number().int().positive().max(8),
  purge: purgeSchema.optional(),
});

export interface StoredRun extends NativeCoordinationRun {
  readonly admissionOwner?: string;
  readonly admissionExpiresAt?: number;
  readonly snapshotDigest: string;
  readonly chunkCount: number;
  readonly byteLength: number;
}
export async function readDynamoSnapshot(
  ddb: DynamoDBDocumentClient,
  table: string,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
  retainedRunId?: string,
): Promise<StoredRun | undefined> {
  const scope = coordinationHeadKey(eventId, problemId);
  const key = retainedRunId ? historyKey(scope.PK, retainedRunId) : scope;
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = (
      await ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))
    ).Item;
    if (!raw) return undefined;
    const head = headSchema.parse(raw);
    assertSnapshotScope(head, eventId, problemId, retainedRunId);
    assertDynamoPayloadAvailable(head);
    const values = await ddb.send(
      new TransactGetCommand({
        TransactItems: [
          ...Array.from({ length: head.chunkCount }, (_, index) => ({
            Get: {
              TableName: table,
              Key: snapshotKey(
                key.PK,
                index,
                head.snapshotLayout === "run" ? head.runId : undefined,
              ),
            },
          })),
          { Get: { TableName: table, Key: key } },
        ],
      }),
    );
    const after = headSchema.safeParse(values.Responses?.at(-1)?.Item);
    if (!after.success || !sameSnapshotLocation(head, after.data)) continue;
    // HEAD and every selected chunk share this transaction's snapshot. The first
    // read only sizes the transaction; an intervening admission or publication
    // does not invalidate an otherwise complete, internally consistent result.
    const current = after.data;
    assertSnapshotScope(current, eventId, problemId, retainedRunId);
    assertDynamoPayloadAvailable(current);
    const chunks = values.Responses?.slice(0, current.chunkCount).map((item) => item.Item) ?? [];
    const bytes = decodedChunks(chunks, current.runId, current.revision);
    if (
      !bytes ||
      bytes.byteLength !== current.byteLength ||
      hash(bytes) !== current.snapshotDigest
    ) {
      if (attempt < 7) continue;
      throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
    }
    const start = performance.now();
    try {
      return parsedRun(current, bytes);
    } finally {
      timing?.({ phase: "decode", elapsedMs: performance.now() - start });
    }
  }
  throw new NativeCoordinationError(409, "coordination_snapshot_changed");
}
export function assertDynamoPayloadAvailable(head: z.infer<typeof headSchema>): void {
  assertPurgeManifest(head);
  if (head.purge) throw new NativeCoordinationError(409, "coordination_run_closed");
}
export function dynamoHeadCheck(
  table: string,
  run: Pick<
    StoredRun,
    "eventId" | "problemId" | "runId" | "revision" | "snapshotDigest" | "closed"
  > & { readonly purge?: PurgeManifest },
): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: coordinationHeadKey(run.eventId, run.problemId),
      ConditionExpression:
        "runId = :run AND revision = :revision AND snapshotDigest = :digest AND closed = :closed" +
        (run.purge ? " AND #purge = :purge" : " AND attribute_not_exists(#purge)"),
      ExpressionAttributeNames: { "#purge": "purge" },
      ExpressionAttributeValues: {
        ":run": run.runId,
        ":revision": run.revision,
        ":digest": run.snapshotDigest,
        ":closed": run.closed,
        ...(run.purge ? { ":purge": run.purge } : {}),
      },
    },
  };
}
export function dynamoHeadAbsent(table: string, eventId: string, problemId: string): Write {
  return {
    ConditionCheck: {
      TableName: table,
      Key: coordinationHeadKey(eventId, problemId),
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}
export function assertSnapshotScope(
  head: z.infer<typeof headSchema>,
  eventId: string,
  problemId: string,
  runId?: string,
): void {
  if (
    head.eventId !== eventId ||
    head.problemId !== problemId ||
    (runId !== undefined && head.runId !== runId)
  )
    throw new NativeCoordinationError(503, "coordination_scope_invalid");
}

function sameSnapshotLocation(
  first: z.infer<typeof headSchema>,
  current: z.infer<typeof headSchema>,
): boolean {
  return (
    first.chunkCount === current.chunkCount &&
    first.snapshotLayout === current.snapshotLayout &&
    (first.snapshotLayout !== "run" || first.runId === current.runId)
  );
}

function parsedRun(head: z.infer<typeof headSchema>, bytes: Buffer): StoredRun {
  const parsed = matchSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  const match = { ...parsed, state: parsed.state };
  if (match.version !== head.revision)
    throw new NativeCoordinationError(503, "coordination_snapshot_invalid");
  return { ...head, match };
}

export function snapshotKey(PK: string, index: number, runId?: string) {
  const prefix = runId ? `RUN#${id.parse(runId)}#` : "";
  return { PK, SK: `${prefix}SNAPSHOT#${index}` };
}
export function historyKey(PK: string, runId: string) {
  return { PK, SK: `RUN#${id.parse(runId)}#HEAD` };
}
export function decodedChunks(
  rows: readonly (Record<string, unknown> | undefined)[],
  runId: string,
  revision: number,
): Buffer | undefined {
  const values: Uint8Array[] = [];
  for (const row of rows) {
    if (
      row?.runId !== runId ||
      row.revision !== revision ||
      !(row.data instanceof Uint8Array) ||
      row.data.byteLength > COORDINATION_CHUNK_BYTES
    )
      return undefined;
    values.push(row.data);
  }
  return Buffer.concat(values);
}

/** Teardown verifies the complete closed snapshot and fences the exact verified revision. */
export async function dynamoCloseFence(
  ddb: DynamoDBDocumentClient,
  table: string,
  eventId: string,
  problemId: string,
  timing?: (sample: CoordinationTiming) => void,
): Promise<Write> {
  const key = coordinationHeadKey(eventId, problemId);
  const raw = (await ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true })))
    .Item;
  if (raw) {
    const head = headSchema.parse(raw);
    assertSnapshotScope(head, eventId, problemId);
    assertPurgeManifest(head);
    if (head.purge) {
      if (head.purge.state !== "complete")
        throw new NativeCoordinationError(503, "coordination_purge_pending");
      return dynamoHeadCheck(table, head);
    }
  }
  const run = await readDynamoSnapshot(ddb, table, eventId, problemId, timing);
  if (!run) return dynamoHeadAbsent(table, eventId, problemId);
  if (!run.closed) throw new NativeCoordinationError(409, "coordination_not_settled");
  return dynamoHeadCheck(table, run);
}
