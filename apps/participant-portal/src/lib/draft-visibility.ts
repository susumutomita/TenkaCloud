import type { ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
import type { ParticipantProblemView } from "../api/portal-client";
import type { CloudMode } from "../config";

/**
 * Issue: draft 問題の表示切り替え。通常プレーでは未完成 (status: "draft") の問題を
 * 一覧・講座 track から隠し、開発者は toggle で全件表示に切り替える。
 *
 * 設計上の不変条件:
 * - 隠すのは「まだ何も起きていない draft」だけ。参加者が進行中のもの — flag を 1 つでも
 *   解いた、container が stopped 以外 (starting / running / error) — は toggle の状態に
 *   かかわらず残す。プレー中・エラー調査中の問題が目の前から消えるのが最悪の挙動だから。
 * - platform が pin する入門ドリル (`recommended: true`) は draft でも常に残す。
 *   初回導線 (「初めてなら」) の唯一の入口で、これが消えると onboarding が壊れる。
 * - catalog に status が無い問題は隠さない (fail-open)。catalog に無い stale problem を
 *   一覧に必ず残す既存規則 (#2882) と同じ向きで、隠す側の誤爆を避ける。
 * - 隠してよいのは quest 一覧が catalog 全件そのものである local play だけ (`hidesDraftProblems`)。
 *   cloud mode の一覧は「運営がこのチームへ deploy した分」しか載らないので、そこで
 *   catalog status を理由に隠すと deploy 済みの問題が参加者から消える。
 * - 設定はこのブラウザ限りの表示上の好みなので localStorage に閉じる。
 */

const STORAGE_KEY = "tenkacloud.showDraftProblems";

/**
 * draft を隠す規則が成立する mode か。
 *
 * `local` (= `make local` の単独ドリル) の quest 一覧は local session が抱える catalog 全件が
 * そのまま並ぶ。未完成問題がそこに混ざるのが #3117 の動機だった。
 *
 * `real` / `mock` は違う。一覧に載るのは運営がこのチームへ deploy した問題だけで、catalog 上
 * まだ draft でも「運営が意図して渡した」ものになる。そこで catalog status を見て隠すと、
 * 目の前で動いている deploy 済みの問題が既定で消え、開発者向け toggle を知らない参加者には
 * 復帰手段が無い。だから隠す判断自体を local に閉じる。
 */
export function hidesDraftProblems(cloudMode: CloudMode): boolean {
  return cloudMode === "local";
}

/** 保存済みの「draft を表示する」設定。未設定・読めない環境 (private window 等) は false。 */
export function readShowDraftProblems(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const store = storage ?? localStorage;
    return store.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** toggle の選択を保存する。保存できない環境では黙って諦める (表示状態は React state が持つ)。 */
export function writeShowDraftProblems(value: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? localStorage;
    store.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    // 好みの永続化に失敗しても現在のセッションの表示は成立している。
  }
}

/** draft でも隠してはいけない問題 (進行中 / 起動済み / pin された入門ドリル)。 */
export function isDraftHideExempt(problem: ParticipantProblemView): boolean {
  if (problem.recommended === true) return true;
  if (problem.lifecycle !== undefined && problem.lifecycle.status !== "stopped") return true;
  const scoring = problem.scoring;
  if (scoring?.kind === "flag") return scoring.flagSubmitted === true;
  if (scoring?.kind === "multi-flag") return (scoring.flags ?? []).some((flag) => flag.solved);
  return false;
}

/**
 * quest 一覧 (deploy 済み problem view) から draft を隠す。
 * `statusOf` は problemId → catalog status。catalog に居ない問題は undefined = 隠さない。
 */
export function hideDraftQuestProblems(
  problems: readonly ParticipantProblemView[],
  statusOf: (problemId: string) => ProblemCatalogEntry["status"] | undefined,
): ParticipantProblemView[] {
  return problems.filter(
    (problem) => statusOf(problem.problemId) !== "draft" || isDraftHideExempt(problem),
  );
}

/**
 * 講座 track の組み立て入力 (catalog entry) から draft を隠す。
 * 対応する problem view が exempt (進行中など) の draft entry は残す。
 *
 * catalog 側は元から「全件を並べた学習経路」なので隠す規則がそのまま成立する。
 * 呼び出し側 (Home / CourseTracks / Quests の track 組み立て) はいずれも
 * `showsCourseTracks` = local mode 限定なので、quest 一覧のような mode 分岐は要らない。
 */
export function hideDraftCatalogEntries(
  entries: readonly ProblemCatalogEntry[],
  problems: readonly ParticipantProblemView[],
): ProblemCatalogEntry[] {
  const exemptIds = new Set(problems.filter(isDraftHideExempt).map((problem) => problem.problemId));
  return entries.filter((entry) => entry.status !== "draft" || exemptIds.has(entry.id));
}

/**
 * toggle 状態つきの quest 一覧。表示中 (showDrafts) は全件そのまま。
 * 隠す規則が成立しない mode (`hidesDraftProblems` が false) でも全件そのまま。
 */
export function visibleQuestProblems(
  problems: readonly ParticipantProblemView[],
  statusOf: (problemId: string) => ProblemCatalogEntry["status"] | undefined,
  showDrafts: boolean,
  cloudMode: CloudMode,
): readonly ParticipantProblemView[] {
  if (showDrafts || !hidesDraftProblems(cloudMode)) return problems;
  return hideDraftQuestProblems(problems, statusOf);
}

/** toggle 状態つきの catalog entry 一覧。表示中 (showDrafts) は全件そのまま。 */
export function visibleCatalogEntries(
  entries: readonly ProblemCatalogEntry[],
  problems: readonly ParticipantProblemView[],
  showDrafts: boolean,
): readonly ProblemCatalogEntry[] {
  return showDrafts ? entries : hideDraftCatalogEntries(entries, problems);
}

/**
 * 保存済みの好みで draft を隠した catalog。toggle を持たない画面 (Home の推薦 /
 * CourseTracks) が Quests と同じ表示規則を共有するための入口。
 */
export function visibleCourseCatalog(
  entries: readonly ProblemCatalogEntry[],
  problems: readonly ParticipantProblemView[],
  storage?: Pick<Storage, "getItem">,
): readonly ProblemCatalogEntry[] {
  return visibleCatalogEntries(entries, problems, readShowDraftProblems(storage));
}
