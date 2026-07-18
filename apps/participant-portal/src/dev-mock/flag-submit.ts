import {
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_FIRST_SCORE,
  LOCAL_DRILL_PROBLEM_ID,
  matchesLiteDrillCheckpoint,
  matchesLocalDrillFirstScore,
} from "@tenkacloud/portal-contracts";
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

/** Issue #2711: チュートリアル問題 what-is-tenkacloud の id (demo fixture 専用)。 */
export const WHAT_IS_DRILL_PROBLEM_ID = "what-is-tenkacloud";

/**
 * Issue #2707 / #2711: クイズ型 sub-flag の許容解。 問題文 (description) を読めば導ける
 * 単語を、 表記揺れ (英/日) 込みで列挙する。 判定は trim + 小文字化の完全一致。
 *
 * what-is-tenkacloud の 4 ステップ (#2711 デザイン 6b):
 *   1. tenka-what      — TenkaCloud とは (本文に答えがある読解クイズ)
 *   2. battle-challenge — Battle と Challenge の区別
 *   3. choose-mode      — モードを選ぶ。 ブラウザ (Lite) / Codespaces のどちらを
 *                         選んでも正解 (= クイズではなく選択。 詳細はヒントに)
 *   4. first-flag       — 本文に印字された flag をそのまま提出する採点体験
 */
const QUIZ_ANSWERS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [WHAT_IS_DRILL_PROBLEM_ID]: {
    "tenka-what": [
      "本物のクラウド",
      "本物のクラウドアカウント",
      "クラウド",
      "real cloud",
      "real cloud accounts",
      "the real cloud",
      "aws",
    ],
    "battle-challenge": ["battle", "バトル"],
    "choose-mode": [
      "lite",
      "ライト",
      "browser",
      "ブラウザ",
      "ブラウザ (lite)",
      "browser (lite)",
      "codespaces",
      "コードスペース",
    ],
    "first-flag": ["tenka{hello-tenkacloud}"],
  },
  [LOCAL_DRILL_PROBLEM_ID]: {
    "portal-port": ["5175"],
  },
};

function matchesQuizAnswer(problemId: string, flagId: string, rawFlag: string): boolean {
  const answers = QUIZ_ANSWERS[problemId]?.[flagId];
  if (!answers) return false;
  return answers.includes(rawFlag.trim().toLowerCase());
}

/**
 * Issue #2696 / #2707: multi-flag 用の dev-mock 判定。 オンボーディングドリル
 * (理解クイズ / ローカル初得点 / Lite デプロイ) は sub-flag ごとの期待解との一致を
 * 要求する (= 手順を踏む・問題文を読むと得られる値の確認がドリルの本体なので、
 * canonical flag / Easter egg では通らない)。 それ以外の multi-flag 問題は従来どおり
 * `evaluateMockFlag` の緩い判定に fallback する。
 */
export function evaluateMockSubFlag(
  problemId: string,
  flagId: string,
  rawFlag: string,
  points: number,
): SubmitFlagOutcome {
  const ok = (): SubmitFlagOutcome => ({ kind: "ok", scoreDelta: points, totalScore: points });
  if (problemId === LITE_DRILL_PROBLEM_ID) {
    return matchesLiteDrillCheckpoint(flagId, rawFlag) ? ok() : WRONG_OUTCOME;
  }
  if (problemId === LOCAL_DRILL_PROBLEM_ID && flagId === LOCAL_DRILL_FIRST_SCORE.flagId) {
    return matchesLocalDrillFirstScore(rawFlag) ? ok() : WRONG_OUTCOME;
  }
  if (QUIZ_ANSWERS[problemId]) {
    return matchesQuizAnswer(problemId, flagId, rawFlag) ? ok() : WRONG_OUTCOME;
  }
  return evaluateMockFlag(rawFlag, points);
}
