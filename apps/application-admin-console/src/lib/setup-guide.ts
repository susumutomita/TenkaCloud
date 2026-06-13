import type { EventStatus, EventSummary } from "../api/events-client";

/**
 * Issue #1773: Tenant Admin 初回セットアップガイド (① イベント作成 → ② 問題選択 →
 * ③ チーム登録 → ④ デプロイ) の完了判定。 新規 backend は持たず、 tenant 内の既存データ
 * (EventSummary 一覧) からのみ導出する純関数群。
 */

export type SetupStepId = "create_event" | "select_problems" | "register_teams" | "deploy";

export interface SetupStepProgress {
  readonly id: SetupStepId;
  readonly complete: boolean;
}

export interface SetupGuideProgress {
  readonly steps: readonly SetupStepProgress[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly allComplete: boolean;
}

/**
 * 「deploy が一度は起動された」 ことを示す status 集合。 DRAFT は未 deploy。 ARCHIVED は
 * DRAFT から直接到達し得る (= 一度も deploy していない可能性がある) ため含めない。
 */
const DEPLOY_TRIGGERED_STATUSES: ReadonlySet<EventStatus> = new Set([
  "DEPLOYING",
  "READY",
  "ENDED",
  "TEARDOWN",
]);

/**
 * 4 ステップの完了状態を event 一覧から導出する。
 *   - create_event: event が 1 件以上存在する
 *   - select_problems: いずれかの event に problem が 1 件以上ある
 *   - register_teams: いずれかの event に team が 1 件以上ある
 *   - deploy: いずれかの event が deploy 起動済 status になっている
 */
export function deriveSetupGuideProgress(events: readonly EventSummary[]): SetupGuideProgress {
  const steps: readonly SetupStepProgress[] = [
    { id: "create_event", complete: events.length > 0 },
    { id: "select_problems", complete: events.some((e) => e.problemCount > 0) },
    { id: "register_teams", complete: events.some((e) => e.teamCount > 0) },
    { id: "deploy", complete: events.some((e) => DEPLOY_TRIGGERED_STATUSES.has(e.status)) },
  ];
  const completedCount = steps.filter((s) => s.complete).length;
  return {
    steps,
    completedCount,
    totalCount: steps.length,
    allComplete: completedCount === steps.length,
  };
}

/**
 * 各 step を完了させる既存ページへの遷移先。 deploy だけは event 依存:
 * 最初の non-ARCHIVED event の詳細 (deploy ボタンがある画面) へ、 無ければ作成 wizard へ。
 */
export function resolveSetupStepHref(id: SetupStepId, events: readonly EventSummary[]): string {
  switch (id) {
    case "create_event":
    case "register_teams":
      // problem / team の選択・登録はどちらも Event 作成 wizard 内で行う。
      return "/events/new";
    case "select_problems":
      return "/problems";
    case "deploy": {
      const target = events.find((e) => e.status !== "ARCHIVED");
      return target ? `/events/${encodeURIComponent(target.eventId)}` : "/events/new";
    }
  }
}

/** Home の onboarding dismiss (#542) と同じ命名規約。 値は "true" のみ意味を持つ。 */
export const SETUP_GUIDE_DISMISSED_KEY = "TenkaCloud.applicationAdmin.setupGuideDismissed";

export function readSetupGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(SETUP_GUIDE_DISMISSED_KEY) === "true";
  } catch {
    // localStorage 不可 (= private mode 等) は「未 dismiss = 毎回表示」で安全側。
    return false;
  }
}

export function writeSetupGuideDismissed(): void {
  try {
    window.localStorage.setItem(SETUP_GUIDE_DISMISSED_KEY, "true");
  } catch {
    // localStorage 不可なら永続化を諦める (= 次回も表示)。 fail loud にする価値がない UI 設定。
  }
}
