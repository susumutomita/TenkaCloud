import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import type { ParticipantProblemView, ParticipantScoringInfo } from "../api/portal-client";

/**
 * 競技者向けの 「解答状態」 (= 解けた / 解けてない)。 #821 / #822 で導入、 issue #34 で
 * 一覧カードの右上 icon に圧縮 (= ラベル無し、 視線を奪わない)。
 */
export type TFn = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface SubmissionState {
  readonly type: StatusIndicatorProps.Type;
  readonly label: string;
}

function renderDeploymentState(
  problem: ParticipantProblemView,
  t: TFn,
): SubmissionState | undefined {
  if (problem.status === "FAILED") return { type: "error", label: t("quests.submission_failed") };
  if (problem.status === "EXPIRED") {
    return { type: "warning", label: t("quests.status_label.EXPIRED") };
  }
  if (problem.status === "DELETED" || problem.status === "AUTO_DELETED") {
    return { type: "stopped", label: t(`quests.status_label.${problem.status}`) };
  }
  if (
    problem.status === "PENDING" ||
    problem.status === "IN_PROGRESS" ||
    problem.status === "DELETING"
  ) {
    return { type: "in-progress", label: t(`quests.status_label.${problem.status}`) };
  }
  // Issue #2019: a held (APPROVAL_PENDING) deploy has no stack yet — present it as
  // in-progress (reusing the PENDING label) so it is never shown as solvable.
  if (problem.status === "APPROVAL_PENDING") {
    return { type: "in-progress", label: t("quests.status_label.PENDING") };
  }
  return undefined;
}

function renderClearedState(points: number | undefined, t: TFn): SubmissionState {
  const label =
    points !== undefined
      ? t("quests.submission_cleared_with_points", { points })
      : t("quests.submission_cleared");
  return { type: "success", label };
}

function renderMultiFlagState(scoring: ParticipantScoringInfo, t: TFn): SubmissionState {
  const flags = scoring.flags ?? [];
  const solved = flags.filter((flag) => flag.solved).length;
  if (solved === 0) {
    return { type: "pending", label: t("quests.submission_unsolved") };
  }
  if (solved === flags.length) return renderClearedState(scoring.points, t);
  return {
    type: "info",
    label: t("quests.submission_in_progress_with_count", { solved, total: flags.length }),
  };
}

/**
 * Issue #1349: 採点状態 badge を unit test 可能な pure function に分離。 各
 * problem の `status` (= deploy 進捗) と scoring の提出状態を見て、
 * 4 状態 (未着手 / Deploy 中 / 着手中 / 解答済) を返す。 解答済 (= flag 提出済) は
 * `scoring.points` があれば 「+Npt」 を末尾に付ける (= 何点 取れたかを一目で出す)。
 */
export function renderSubmissionState(problem: ParticipantProblemView, t: TFn): SubmissionState {
  const deploymentState = renderDeploymentState(problem, t);
  if (deploymentState) return deploymentState;
  if (problem.scoring?.kind === "flag") {
    if (problem.scoring.flagSubmitted) return renderClearedState(problem.scoring.points, t);
    return { type: "pending", label: t("quests.submission_unsolved") };
  }
  // Issue #2885: local container の multi-verify は participant view では multi-flag。
  // runtime が COMPLETE でも、checkpoint を 1 件も出していなければ「挑戦中」ではなく
  // 「未解答」。一部だけ解いたときに初めて進捗を表示し、全件でクリア扱いにする。
  if (problem.scoring?.kind === "multi-flag") {
    return renderMultiFlagState(problem.scoring, t);
  }
  return { type: "info", label: t("quests.submission_in_progress") };
}
