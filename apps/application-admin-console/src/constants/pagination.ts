/**
 * Deployment 一覧取得の 1 ページ最大件数。MVP-1 規模 (~10 deployments) は 1 ページで収まる。
 *
 * `utils/deployments.ts` (Deployments / ProblemDetail の listDeployments limit) が単一 source。
 */
export const DEPLOYMENT_PAGE_SIZE = 50;
