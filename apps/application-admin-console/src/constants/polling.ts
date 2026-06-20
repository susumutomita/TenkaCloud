/**
 * Deployment-cluster (一覧 + 詳細) 共通の polling 間隔 (ms)。
 *
 * `utils/deployments.ts` (一覧: Deployments / ProblemDetail) と
 * `pages/deployment-detail/useDeploymentDetail.ts` (詳細) が同じ 30 秒を別々に
 * 定義していたのを単一 source へ集約する。
 *
 * Lambda invocation コスト抑制のため 30 秒 (= 旧 5〜10 秒 polling は 6〜12 req/min/user で過多)。
 * deploy phase の進行は CloudFormation 側で数十秒〜数分単位なので、 30 秒粒度で十分。
 */
export const DEPLOYMENT_POLL_INTERVAL_MS = 30_000;
