/**
 * Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) の pure predicate 群。
 *
 * `/portal/me` の `progression` (= `ParticipantProgressionView`) を入力に、
 *   - どの問題が prerequisite-locked か (`isPrerequisiteLocked`)
 *   - どのカードに 「最初にここから」 を出すか (`isGateAwaitingCompletion`)
 *   - Gate 問題の表示名 / 詳細ページ link 先 (`findGateProblem` / `gateProblemDisplayName`)
 * を導出する。 Quests 一覧と ProblemDetail の両方が使うため page ではなく lib に置く
 * (= `lib/category.ts` と同じ配置方針)。
 *
 * ここは 「表示の出し分け」 のみ。 実際の拒否は backend の access guard
 * (409 challenge_prerequisite_not_met) が行うので、 UI 改ざんでは bypass できない。
 */

import type { ParticipantProblemView, ParticipantProgressionView } from "../api/portal-client";

/**
 * 該当 problemId が現時点で locked (= Gate 未完了のため開始不可) なら true。
 * progression 不在 (= Gate 設定なし / feature flag OFF) は常に false (= 従来挙動)。
 */
export function isPrerequisiteLocked(
  progression: ParticipantProgressionView | undefined,
  problemId: string | undefined,
): boolean {
  if (!progression || !problemId) return false;
  return progression.lockedProblemIds.includes(problemId);
}

/**
 * 該当 problemId が Gate 問題そのもので、 かつ自 team が未完了、 かつ実際に locked な問題が
 * あるなら true (= 「最初にここから」 badge / 完了で他問題が解放される旨の hint を出す)。
 *
 * `lockedProblemIds` が空 (= policy "off" の team は Gate 未完了でも何も locked されない) なら
 * 「完了で解放」 の約束は虚偽になるため出さない。 完了 bonus の予告は locked の有無と無関係に
 * 意味を持つので {@link hasGateCompletionBonus} に分離する。
 */
export function isGateAwaitingCompletion(
  progression: ParticipantProgressionView | undefined,
  problemId: string | undefined,
): boolean {
  if (!progression || !problemId) return false;
  return (
    progression.gateProblemId === problemId &&
    !progression.gateCompleted &&
    progression.lockedProblemIds.length > 0
  );
}

/**
 * 該当 problemId が Gate 問題そのもので、 未完了かつ完了 bonus (> 0) が設定されているなら true
 * (= 「完了で +Npt」 badge)。 policy "off" (= locked 無し) の team にも bonus は付与されるため、
 * {@link isGateAwaitingCompletion} と違い lockedProblemIds は見ない。
 */
export function hasGateCompletionBonus(
  progression: ParticipantProgressionView | undefined,
  problemId: string | undefined,
): boolean {
  if (!progression || !problemId) return false;
  return (
    progression.gateProblemId === problemId &&
    !progression.gateCompleted &&
    progression.completionBonus > 0
  );
}

/**
 * team view の問題一覧から Gate 問題の deploy 行を引く (= 詳細ページ `/problems/:jobId`
 * への link 先解決用)。 Gate 問題が自 team に deploy されていなければ undefined。
 */
export function findGateProblem(
  progression: ParticipantProgressionView | undefined,
  problems: readonly ParticipantProblemView[] | undefined,
): ParticipantProblemView | undefined {
  if (!progression || !problems) return undefined;
  return problems.find((p) => p.problemId === progression.gateProblemId);
}

/**
 * Gate 問題の競技者向け表示名。 team view から name が引ければそれを、
 * 引けなければ problemId (slug) を fall back として返す。
 */
export function gateProblemDisplayName(
  progression: ParticipantProgressionView | undefined,
  problems: readonly ParticipantProblemView[] | undefined,
): string {
  if (!progression) return "";
  const gate = findGateProblem(progression, problems);
  return gate?.name ?? progression.gateProblemId;
}
