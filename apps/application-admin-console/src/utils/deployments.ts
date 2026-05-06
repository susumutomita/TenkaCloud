import type { DeploymentSummary } from "../api/deploy-client";

/** Polling list pages の polling 間隔。`Deployments.tsx` / `ProblemDetail.tsx` 両方で共有。 */
export const DEPLOYMENT_LIST_POLL_INTERVAL_MS = 10_000;

/**
 * Polling 結果の安定 reference 用 frozen const。`items ?? EMPTY_DEPLOYMENT_ITEMS` で
 * Cloudscape `<Table>` の prop を毎 render 新規確保しないようにする。
 */
export const EMPTY_DEPLOYMENT_ITEMS: readonly DeploymentSummary[] = Object.freeze([]);

/** 1 ページの最大件数。MVP-1 規模 (~10 deployments) は 1 ページで収まる。 */
export const DEPLOYMENT_LIST_PAGE_SIZE = 50;

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
