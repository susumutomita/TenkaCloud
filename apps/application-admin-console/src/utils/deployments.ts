import type { DeploymentSummary } from "../api/deploy-client";
import { DEPLOYMENT_PAGE_SIZE } from "../constants/pagination";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Polling list pages の polling 間隔。`Deployments.tsx` / `ProblemDetail.tsx` 両方で共有。
 * deployment-cluster 共通の単一 source ({@link DEPLOYMENT_POLL_INTERVAL_MS}) を再 export する。
 * Lambda invocation コスト抑制のため 30 秒 (= 過去 10 秒 = 6 req/min/user で過多)。
 */
export const DEPLOYMENT_LIST_POLL_INTERVAL_MS = DEPLOYMENT_POLL_INTERVAL_MS;

/**
 * Polling 結果の安定 reference 用 frozen const。`items ?? EMPTY_DEPLOYMENT_ITEMS` で
 * Cloudscape `<Table>` の prop を毎 render 新規確保しないようにする。
 */
export const EMPTY_DEPLOYMENT_ITEMS: readonly DeploymentSummary[] = Object.freeze([]);

/**
 * 1 ページの最大件数。MVP-1 規模 (~10 deployments) は 1 ページで収まる。
 * deployment-cluster 共通の単一 source ({@link DEPLOYMENT_PAGE_SIZE}) を再 export する。
 */
export const DEPLOYMENT_LIST_PAGE_SIZE = DEPLOYMENT_PAGE_SIZE;

/**
 * Polling で取得した `DeploymentSummary[]` の前回 / 今回が「意味的に同じ」なら true。
 * `setItems((prev) => deploymentsChanged(prev, next) ? next : prev)` の guard で
 * polling tick の no-op render を抑制する。
 *
 * 比較対象は jobId / status / updatedAt / displayTeamName のみ。
 * stackOutputs / score 等は今のところ list 表示で使わないので除外。
 */
export function deploymentsChanged(
  prev: readonly DeploymentSummary[],
  next: readonly DeploymentSummary[],
): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b) return true;
    if (
      a.jobId !== b.jobId ||
      a.status !== b.status ||
      a.updatedAt !== b.updatedAt ||
      a.displayTeamName !== b.displayTeamName
    ) {
      return true;
    }
  }
  return false;
}
