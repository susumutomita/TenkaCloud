import type { SubmitFlagOutcome } from "../api/portal-client";

/**
 * dev-mock 用の flag 検証ロジック。
 *
 * 本物の AWS / scoring backend は存在しないので、 LP 「モックで試す」 動線では portal
 * の `submitFlag` を呼ぶ代わりに本関数を直接 invoke する。 LP visitor が submit 体験
 * (= celebration / wrong-answer の両方) を実機と同じ UX で試せるようにする。
 *
 * 正解判定:
 *   1. canonical flag `tenkacloudsample` を `includes` で部分一致 (= 大文字小文字を
 *      区別しない)。 typo 寛容 (`tenkacloud` 等の prefix 単独でも OK)。
 *   2. EASTER_EGGS のいずれかと exact match。
 *
 * これ以外は wrong (= -10 pt + リトライ可)。
 *
 * Easter egg は demo UX を盛り上げる遊び (= `42` / `claude` / `kaizen` / `tenkadev`
 * / `konnichiwa` / `tenka`)。 production code には影響しないので 「mock-only の
 * 余り遊び」 として fixture 側 (= 本ファイル) に閉じ込める。
 */

export const CANONICAL_MOCK_FLAG = "tenkacloudsample";

export const EASTER_EGGS: readonly string[] = [
  "42",
  "claude",
  "kaizen",
  "tenkadev",
  "konnichiwa",
  "tenka",
];

const WRONG_OUTCOME: SubmitFlagOutcome = {
  kind: "wrong",
  scoreDelta: -10,
  totalScore: -10,
  wrongCount: 1,
};

function isCanonicalMatch(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  // `tenkacloudsample` を含むか、 逆に `tenkacloudsample` が入力を含む (= prefix
  // 単独 `tenkacloud` も OK)
  return trimmed.includes(CANONICAL_MOCK_FLAG) || CANONICAL_MOCK_FLAG.includes(trimmed);
}

function isEasterEgg(trimmed: string): boolean {
  return EASTER_EGGS.includes(trimmed);
}

export function evaluateMockFlag(rawFlag: string, points: number): SubmitFlagOutcome {
  const trimmed = rawFlag.trim().toLowerCase();
  if (isCanonicalMatch(trimmed) || isEasterEgg(trimmed)) {
    return { kind: "ok", scoreDelta: points, totalScore: points };
  }
  return WRONG_OUTCOME;
}
