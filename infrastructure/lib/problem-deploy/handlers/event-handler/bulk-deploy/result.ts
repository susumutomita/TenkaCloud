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
}): BulkDeployResult {
  const base: BulkDeployResult = {
    eventId: args.eventId,
    enqueued: args.enqueued,
    skipped: args.skipped,
  };
  if (args.unverifiedAccounts.size === 0) return base;
  return {
    ...base,
    unverified: args.unverifiedAccounts.size,
    unverifiedAccounts: Array.from(args.unverifiedAccounts).sort(),
  };
}
