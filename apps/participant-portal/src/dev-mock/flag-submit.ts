import {
  LITE_CLEANUP_DRILL_PROBLEM_ID,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_LAUNCH_COMMAND,
  LOCAL_DRILL_PROBLEM_ID,
  matchesLiteCleanupDrillCheckpoint,
  matchesLiteDrillCheckpoint,
  matchesLocalDrillLaunchCommand,
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
  return { kind: "wrong", scoreDelta: -10, totalScore: -10, wrongCount: 1 };
}

/**
 * dev-mock は backend の score / wrongCount 集計を持たないため、 problem ごとの
 * 累計スコアと flag ごとの不正解回数を module 内で数える。 これが無いと 2 回目
 * 以降の不正解で Alert の数字が一切変化せず 「提出しても反応が無い」 ように見える
 * (2026-07-21 デモ報告)。 実採点と同じく累計は 0 pt を下回らない。
 */
const mockProblemScores = new Map<string, number>();
const mockWrongCounts = new Map<string, number>();

/** テスト間の module state 汚染を防ぐ reset。 production からは呼ばない。 */
export function resetMockScoring(): void {
  mockProblemScores.clear();
  mockWrongCounts.clear();
}

function okOutcome(problemId: string, points: number): SubmitFlagOutcome {
  const total = (mockProblemScores.get(problemId) ?? 0) + points;
  mockProblemScores.set(problemId, total);
  return { kind: "ok", scoreDelta: points, totalScore: total };
}

function wrongOutcome(problemId: string, flagId: string): SubmitFlagOutcome {
  const key = `${problemId}/${flagId}`;
  const count = (mockWrongCounts.get(key) ?? 0) + 1;
  mockWrongCounts.set(key, count);
  const total = Math.max(0, (mockProblemScores.get(problemId) ?? 0) - 10);
  mockProblemScores.set(problemId, total);
  return { kind: "wrong", scoreDelta: -10, totalScore: total, wrongCount: count };
}

/** Issue #2711: チュートリアル問題 what-is-tenkacloud の id (demo fixture 専用)。 */
export const WHAT_IS_DRILL_PROBLEM_ID = "what-is-tenkacloud";

/** LP のプロンプトから Mac ローカル起動までを追う AI-agent チュートリアル。 */
export const AI_AGENT_LOCAL_DRILL_PROBLEM_ID = "ai-agent-local-mac";

/**
 * デモ問題一覧の jobId。 fixture の出題と、 what-is チュートリアル完走パネルの
 * 「次のドリルへ」 ボタン (Lite / ローカル) が同じ問題ページを指すよう共有する。
 */
export const LITE_DRILL_JOB_ID = "01HZX0KZZ3DR0PW9M4Q7XV2C5D";
export const LOCAL_DRILL_JOB_ID = "01HZX0M1L0CALPLAYTENKA0002";

/**
 * Issue #2707 / #2711: クイズ型 sub-flag の許容解。 問題文 (description) を読めば導ける
 * 単語を、 表記揺れ (英/日) 込みで列挙する。 判定は trim + 小文字化の完全一致。
 *
 * what-is-tenkacloud の 4 ステップ (#2711 デザイン 6b):
 *   1. tenka-what      — TenkaCloud とは (本文に答えがある読解クイズ)
 *   2. battle-challenge — Battle と Challenge の区別
 *   3. choose-mode      — モードを選ぶ。 ローカル / Lite / SaaS (+ 文脈で触れる
 *                         Always-On) のどれを選んでも正解 (= クイズではなく選択。
 *                         詳細はヒントに)
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
      "local",
      "ローカル",
      "ローカルモード",
      "local mode",
      "lite",
      "ライト",
      "lite モード",
      "lite mode",
      "saas",
      "サース",
      "saas モード",
      "saas mode",
      // 本文で文脈として触れる Always-On も実在モードなので正解として受け付ける
      "always-on",
      "alwayson",
      "always on",
      "always-on モード",
      // Codespaces はローカルモードの実行環境の 1 つなので正解のまま受け付ける
      "codespaces",
      "コードスペース",
    ],
    "first-flag": ["tc{hello-tenkacloud}"],
  },
  [LOCAL_DRILL_PROBLEM_ID]: {
    "portal-port": ["5175"],
  },
  [AI_AGENT_LOCAL_DRILL_PROBLEM_ID]: {
    "briefing-file": [
      "llms-full.txt",
      "https://tenkacloud.com/llms-full.txt",
      "https://www.tenkacloud.com/llms-full.txt",
    ],
    "portal-port": ["5175"],
  },
};

/**
 * #2711 follow-up: 厳密判定のオンボーディングドリルか。 これらの問題では
 * 「`tenkacloudsample` で正解を体験できる」 という緩い demo 判定のヘルパー文言を
 * 出さない (従うと wrong になる誤案内のため)。
 */
export function isStrictDrillProblem(problemId: string): boolean {
  return (
    problemId === WHAT_IS_DRILL_PROBLEM_ID ||
    problemId === LOCAL_DRILL_PROBLEM_ID ||
    problemId === LITE_CLEANUP_DRILL_PROBLEM_ID ||
    problemId === LITE_DRILL_PROBLEM_ID
  );
}

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
  const ok = () => okOutcome(problemId, points);
  const wrong = () => wrongOutcome(problemId, flagId);
  if (problemId === LITE_DRILL_PROBLEM_ID) {
    return matchesLiteDrillCheckpoint(flagId, rawFlag) ? ok() : wrong();
  }
  if (problemId === LITE_CLEANUP_DRILL_PROBLEM_ID) {
    return matchesLiteCleanupDrillCheckpoint(flagId, rawFlag) ? ok() : wrong();
  }
  if (problemId === LOCAL_DRILL_PROBLEM_ID && flagId === LOCAL_DRILL_LAUNCH_COMMAND.flagId) {
    return matchesLocalDrillLaunchCommand(rawFlag) ? ok() : wrong();
  }
  if (QUIZ_ANSWERS[problemId]) {
    return matchesQuizAnswer(problemId, flagId, rawFlag) ? ok() : wrong();
  }
  const trimmed = rawFlag.trim().toLowerCase();
  return isCanonicalMatch(trimmed) || isEasterEgg(trimmed) ? ok() : wrong();
}
