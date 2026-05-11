import type { EventDeploymentSummary, EventStatus } from "../api/events-client";

export type WizardStepKey =
  | "draft"
  | "deploying"
  | "ready_unscheduled"
  | "scheduled"
  | "in_competition"
  | "ended"
  | "teardown"
  | "archived";

export type WizardPrimary = "deploy" | "start" | "end" | "delete" | null;

export interface WizardState {
  readonly step: WizardStepKey;
  readonly stepIndex: number;
  readonly primary: WizardPrimary;
  readonly cta: string;
  readonly alertType: "info" | "success" | "warning";
}

export interface EventWizardInput {
  readonly status: EventStatus;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly deploymentsByProblem?: Readonly<Record<string, readonly EventDeploymentSummary[]>>;
}

/**
 * #531 Wizard step ラベル (5 段表示)。READY 状態 (= 3, 4) は startsAt / 現在時刻で
 * 「開始待ち / 採点中」を分岐する。TEARDOWN / ARCHIVED は終了系として step 5 に集約。
 */
export const WIZARD_STEPS: readonly { key: WizardStepKey; label: string }[] = [
  { key: "draft", label: "作成" },
  { key: "deploying", label: "Deploy" },
  { key: "ready_unscheduled", label: "開始時刻設定" },
  { key: "in_competition", label: "競技中" },
  { key: "ended", label: "終了" },
] as const;

function deploymentProgress(deploymentsByProblem: EventWizardInput["deploymentsByProblem"]): {
  total: number;
  complete: number;
  failed: number;
} {
  let total = 0;
  let complete = 0;
  let failed = 0;
  if (!deploymentsByProblem) return { total, complete, failed };
  for (const list of Object.values(deploymentsByProblem)) {
    for (const d of list) {
      total += 1;
      if (d.status === "COMPLETE") complete += 1;
      if (d.status === "FAILED") failed += 1;
    }
  }
  return { total, complete, failed };
}

/**
 * #531: EventDetail の「初見でも次に何を押せばいいか」を表す Wizard state。
 *
 * status + startsAt + 現在時刻 + deployment 進捗 を入力に、
 *   - step: 5 段の進捗 (作成 → Deploy → 開始時刻設定 → 競技中 → 終了)
 *   - primary: その state で primary variant にすべき action button
 *   - cta: Alert banner に出す operator 向け案内文
 *   - alertType: Alert の type (info = 要操作、success = 進行中)
 * を返す純粋関数。
 *
 * - DRAFT: Deploy 待ち。primary=deploy
 * - DEPLOYING: 進行中。primary=null (進捗だけ見せる)
 * - READY + startsAt なし: 開始時刻設定待ち。primary=start
 * - READY + startsAt 未来: 開始予定。primary=null
 * - READY + startsAt 過去: 競技中。primary=null (採点中、操作不要)
 * - ENDED: 終了。primary=delete (= Bulk Teardown)
 * - TEARDOWN: 削除中。primary=null
 * - ARCHIVED: アーカイブ済。primary=null
 */
export function computeEventWizardState(input: EventWizardInput, nowMs: number): WizardState {
  const { status, startsAt, deploymentsByProblem } = input;

  if (status === "DRAFT") {
    return {
      step: "draft",
      stepIndex: 0,
      primary: "deploy",
      cta: "Event を作成しました。「Deploy」 button で全 team × 全問題の deploy を開始してください。",
      alertType: "info",
    };
  }

  if (status === "DEPLOYING") {
    const { total, complete, failed } = deploymentProgress(deploymentsByProblem);
    const tail = total > 0 ? ` (${complete} / ${total} 完了、失敗 ${failed} 件)` : "";
    return {
      step: "deploying",
      stepIndex: 1,
      primary: null,
      cta: `Deploy 進行中${tail}。全 deployment が COMPLETE になると自動で READY に遷移します。`,
      alertType: "success",
    };
  }

  if (status === "READY") {
    if (!startsAt) {
      return {
        step: "ready_unscheduled",
        stepIndex: 2,
        primary: "start",
        cta: "Deploy 完了。競技開始時刻を設定すると HealthCheck が採点を開始します。「即座に開始」 または 「日時を指定して開始」 を押してください。",
        alertType: "info",
      };
    }
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) {
      return {
        step: "scheduled",
        stepIndex: 2,
        primary: null,
        cta: `開始時刻設定済 (${startsAt})。指定時刻まで採点は停止中。`,
        alertType: "success",
      };
    }
    return {
      step: "in_competition",
      stepIndex: 3,
      primary: null,
      cta: "競技中。スコアが Participant Portal で更新中です。終了するときは 「Event を終了」 を押すか、終了時刻 (endsAt) を設定してください。",
      alertType: "success",
    };
  }

  if (status === "ENDED") {
    return {
      step: "ended",
      stepIndex: 4,
      primary: "delete",
      cta: "Event 終了。採点は停止しています。「Delete」 で全 deployment を一括削除できます。",
      alertType: "info",
    };
  }

  if (status === "TEARDOWN") {
    return {
      step: "ended",
      stepIndex: 4,
      primary: null,
      cta: "deployment 削除中… 全削除が完了すると自動で ARCHIVED に遷移します。",
      alertType: "warning",
    };
  }

  // ARCHIVED
  return {
    step: "archived",
    stepIndex: 4,
    primary: null,
    cta: "アーカイブ済 (deployment は全削除済)。閲覧のみ可能です。",
    alertType: "success",
  };
}
