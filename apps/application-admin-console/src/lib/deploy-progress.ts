import type { DeploymentStatus } from "../api/deploy-client";

/**
 * 1 件の deployment が「 何 % 進んだか」 の重み。
 *
 * EventDetail 画面の全体プログレスバーは旧実装で `(完了数 / 総数) * 100` だった
 * (= 1 件運用なら 0 % か 100 % の 2 値で動かない)。 ここで status 別の中間重みを
 * 与えることで、 1 件運用でも PENDING (5 %) → IN_PROGRESS (50 %) → DELETING (80 %)
 * → terminal (100 %) と段階的に進む。
 *
 * 値は粗いが「 動いてる感」 を出すための UX 指標で、 厳密な物理進捗ではない
 * (= 厳密に出すには backend で CFn event count / build phase % が必要)。
 */
export function deploymentProgressWeight(status: DeploymentStatus): number {
  switch (status) {
    case "PENDING":
      return 5;
    case "IN_PROGRESS":
      return 50;
    case "DELETING":
      return 80;
    case "COMPLETE":
    case "FAILED":
    case "DELETED":
    case "EXPIRED":
    case "AUTO_DELETED":
      return 100;
  }
}

/**
 * 複数 deployment 全体の進捗 % を返す。
 * 0 件のときは 0 を返す (= ProgressBar 非表示は呼び出し側で判定)。
 */
export function aggregateDeployProgressPercent(statuses: readonly DeploymentStatus[]): number {
  if (statuses.length === 0) return 0;
  const totalWeight = statuses.reduce((sum, s) => sum + deploymentProgressWeight(s), 0);
  return Math.round(totalWeight / statuses.length);
}
