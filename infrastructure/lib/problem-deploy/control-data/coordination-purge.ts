import { z } from "zod";
import { digestSchema, id } from "./coordination-state.js";
import { NativeCoordinationError, SQL_COORDINATION_MAX_BYTES } from "./domain/coordination.js";

const runReferenceSchema = z
  .object({
    runId: id,
    revision: z.number().int().nonnegative(),
    snapshotDigest: digestSchema,
    byteLength: z.number().int().positive().max(SQL_COORDINATION_MAX_BYTES),
    chunkCount: z.number().int().positive().max(8),
    snapshotLayout: z.literal("run").optional(),
  })
  .strict();

/** A permanent receipt of verified closure; only its state changes during cleanup. */
export const purgeSchema = z
  .object({
    state: z.enum(["pending", "complete"]),
    runs: z.array(runReferenceSchema).min(1).max(4),
  })
  .strict();
export type PurgeManifest = z.infer<typeof purgeSchema>;

export function purgeRunReference(run: z.infer<typeof runReferenceSchema>) {
  return runReferenceSchema.parse({
    runId: run.runId,
    revision: run.revision,
    snapshotDigest: run.snapshotDigest,
    byteLength: run.byteLength,
    chunkCount: run.chunkCount,
    ...(run.snapshotLayout ? { snapshotLayout: run.snapshotLayout } : {}),
  });
}

export function assertPurgeManifest(
  head: z.infer<typeof runReferenceSchema> & {
    readonly closed: boolean;
    readonly history?: readonly string[];
    readonly retiredRuns?: readonly string[];
    readonly purge?: PurgeManifest;
    readonly admissionOwner?: string;
    readonly admissionExpiresAt?: number;
  },
): void {
  if (!head.purge) return;
  const expected = [head.runId, ...(head.history ?? []), ...(head.retiredRuns ?? [])];
  if (
    !head.closed ||
    head.admissionOwner !== undefined ||
    head.admissionExpiresAt !== undefined ||
    new Set(expected).size !== expected.length ||
    head.purge.runs.length !== expected.length ||
    head.purge.runs.some((run, index) => run.runId !== expected[index]) ||
    JSON.stringify(head.purge.runs[0]) !== JSON.stringify(purgeRunReference(head))
  )
    throw new NativeCoordinationError(503, "coordination_purge_invalid");
}
