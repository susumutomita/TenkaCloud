import type { BulkDeployOutcome, BulkDeployResult } from "./types.js";

/** teams/problems 0 件 or 全 skip 時に返す「enqueued 0、 unverified 情報なし」の result。 */
export function emptyBulkDeployResult(eventId: string): BulkDeployOutcome {
  return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
}

/**
 * Phase 2.2 (Issue #459): result builder。`unverifiedAccounts` が空のときは
 * `unverified` / `unverifiedAccounts` フィールド自体を出さない (= 既存 client が
 * 後方互換)。あるときは sorted array で安定出力する (= operator UI 表示用)。
 */
export function buildResult(args: {
  readonly eventId: string;
  readonly enqueued: number;
  readonly skipped: number;
  readonly unverifiedAccounts: Set<string>;
  readonly unsupportedRuntimeProblems?: Set<string>;
}): BulkDeployResult {
  let result: BulkDeployResult = {
    eventId: args.eventId,
    enqueued: args.enqueued,
    skipped: args.skipped,
  };
  if (args.unverifiedAccounts.size > 0) {
    result = {
      ...result,
      unverified: args.unverifiedAccounts.size,
      unverifiedAccounts: Array.from(args.unverifiedAccounts).sort(),
    };
  }
  // [#2563 v1] Surface bulk-refused non-AWS problems so the operator learns to
  // use the single-deploy path (same backward-compat shape as `unverified`).
  if (args.unsupportedRuntimeProblems !== undefined && args.unsupportedRuntimeProblems.size > 0) {
    result = {
      ...result,
      unsupportedRuntime: args.unsupportedRuntimeProblems.size,
      unsupportedRuntimeProblems: Array.from(args.unsupportedRuntimeProblems).sort(),
    };
  }
  return result;
}
