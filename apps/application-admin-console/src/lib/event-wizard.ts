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

/**
 * #531: EventDetail の「初見でも次に何を押せばいいか」を表す Wizard state。
 *
 * status + startsAt + 現在時刻 を入力に、
 *   - step: 5 段の進捗 (作成 → Deploy → 開始時刻設定 → 競技中 → 終了)
 *   - stepIndex: phase indicator の現在地 (0-origin)
 *   - primary: その state で primary variant にすべき action button
 * を返す純粋関数。 旧版は Alert banner 用の `cta` / `alertType` も返していたが、 「次のアクション」
 * banner を Overview から削除した (= phase indicator と重複) ため不要になった。
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
  const { status, startsAt } = input;

  if (status === "DRAFT") {
    return { step: "draft", stepIndex: 0, primary: "deploy" };
  }

  if (status === "DEPLOYING") {
    return { step: "deploying", stepIndex: 1, primary: null };
  }

  if (status === "READY") {
    if (!startsAt) {
      return { step: "ready_unscheduled", stepIndex: 2, primary: "start" };
    }
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) {
      return { step: "scheduled", stepIndex: 2, primary: null };
    }
    return { step: "in_competition", stepIndex: 3, primary: null };
  }

  if (status === "ENDED") {
    return { step: "ended", stepIndex: 4, primary: "delete" };
  }

  if (status === "TEARDOWN") {
    return { step: "ended", stepIndex: 4, primary: null };
  }

  // ARCHIVED
  return { step: "archived", stepIndex: 4, primary: null };
}
