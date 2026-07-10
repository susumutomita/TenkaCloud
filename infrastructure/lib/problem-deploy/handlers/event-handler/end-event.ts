import type {
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import {
  type EventSharedResources,
  resolveDeploymentsRepository,
  resolveEventRepositories,
} from "./shared.js";

/**
 * `endEvent` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `not_endable`: status が END に遷移可能でない (DRAFT / DEPLOYING / TEARDOWN /
 *    ARCHIVED / ENDED) → 409 相当。READY のみ許可。
 * - `ok`: 終了完了。endsAt と影響を受けた deployment 数を返す。
 */
export type EndEventOutcome =
  | { kind: "not_found" }
  | { kind: "not_endable"; status: string }
  | { kind: "ok"; endsAt: string; updatedDeployments: number };

/**
 * Event を `ENDED` 状態にし、紐づく全 deployment 行に `eventEndsAt` を denormalize する。
 *
 * HealthCheckLambda は deployment 行の `eventEndsAt` を見て probe / 採点 gate を切る
 * (now >= eventEndsAt なら skip)。Bulk Teardown 待たずに採点を停めるための path
 * (Issue #494)。Event 単独更新では足りないので schedule.ts と同じ denormalize 戦略。
 *
 * `READY` 状態のみ「終了」可能。
 *   - `DRAFT` / `DEPLOYING`: まだ動いていないので無意味
 *   - `TEARDOWN` / `ARCHIVED`: 既に teardown 済 → 終了は redundant
 *   - `ENDED`: 二重操作防止
 *
 * Issue #1095: ENDED 遷移と同時に `scoringLocked = true` も atomic に立てる (詳細は
 * repository seam の `endEvent` 実装コメント参照)。
 *
 * [#2437 Phase A2] READY→ENDED の条件付き書き込みは repository seam の
 * `endEvent(tenantId, eventId, at)` に移設。 CCF catch + probe Get の分岐は
 * `EventMutationOutcome` union の分岐に置き換え (HTTP ステータス対応は不変)。
 * mirror backend (`CONTROL_DATA_BACKEND=turso`) でも効くよう、 event-api の write は
 * `resolveEventRepositories` (= runtime resolver 経由、 default backend は byte 互換) を使う。
 */
export async function endEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<EndEventOutcome> {
  const now = new Date(nowMs).toISOString();

  const repositories = await resolveEventRepositories(shared);
  const result = await repositories.events.endEvent(tenantId, eventId, now);
  if (result.outcome === "not_found") return { kind: "not_found" };
  if (result.outcome === "conflict") {
    // 条件不成立 = status != READY。 probe された event の status を露出する。
    return {
      kind: "not_endable",
      status: typeof result.event?.status === "string" ? result.event.status : "?",
    };
  }
  // updated: 成功判定は outcome 自身が担う。 post-image 無しの degenerate 応答
  // (ALL_NEW が Attributes を返さない) は repository 層が not_found に畳み済み。

  const repo: DeploymentsQueryPort & DeploymentsLifecyclePort =
    await resolveDeploymentsRepository(shared);
  const targetJobIds = await repo.listDeploymentKeysByEvent(tenantId, eventId);

  // #872: tenantId 一致を atomic に強制 (= queryDeploymentsByEvent が GSI1=TENANT#... で
  // 引いているので transitively 安全だが、 write レベルで明示する defense-in-depth)。
  // [Issue #2441 / Phase B2] `stampEventEndsAt` folds the CCF into a `not_found`
  // outcome instead of throwing (item が消えた / tenant 不一致 → idempotent な
  // denormalize なので discard = 旧 CCF-catch と同じ skip)。
  await Promise.all(targetJobIds.map((jobId) => repo.stampEventEndsAt(jobId, tenantId, now, now)));

  return { kind: "ok", endsAt: now, updatedDeployments: targetJobIds.length };
}
