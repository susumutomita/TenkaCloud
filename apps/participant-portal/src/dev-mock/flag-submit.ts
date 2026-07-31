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
 * Issue #2781: オンボーディング最終問題。 解く側から作る側へ移る 6 問目で、
 * Problem Pack に `hello-world` を残したまま 2 問目の独自 Challenge を追加する。
 */
export const CUSTOM_CHALLENGE_PROBLEM_ID = "add-custom-challenge";
/** 標準 validator が通した Problem 数 (= `hello-world` + 独自問題で 2)。 */
export const CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID = "problem-count";
/** チュートリアル専用 verifier が印字する `TC{CUSTOM-CHALLENGE:<id>}` checkpoint。 */
export const CUSTOM_CHALLENGE_VERIFIED_FLAG_ID = "custom-challenge-verified";

/**
 * デモ問題一覧の jobId。 fixture の出題と、 what-is チュートリアル完走パネルの
 * 「次のドリルへ」 ボタン (Lite / ローカル) が同じ問題ページを指すよう共有する。
 */
export const LITE_DRILL_JOB_ID = "01HZX0KZZ3DR0PW9M4Q7XV2C5D";
export const LOCAL_DRILL_JOB_ID = "01HZX0M1L0CALPLAYTENKA0002";

/**
 * 厳密ドリルの許容解。#2822 の what-is-tenkacloud は独自の client-side クイズを使わず、
 * 6 ステップすべてを標準の multi-flag 入力・ヒント公開・採点経路で体験する。
 */
const QUIZ_ANSWERS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [WHAT_IS_DRILL_PROBLEM_ID]: {
    "tenka-what": ["本物のクラウド", "real cloud"],
    "battle-challenge": ["battle", "バトル"],
    "choose-mode": ["local", "ローカル", "local mode", "ローカルモード"],
    "read-problem": ["問題文", "problem statement"],
    "open-endpoint": ["接続先", "endpoint"],
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
  [CUSTOM_CHALLENGE_PROBLEM_ID]: {
    // `hello-world` を残したまま 2 問目を足すので、 validator が通す Problem 数は 2。
    [CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID]: ["2"],
  },
};

/**
 * Issue #2781: verifier が成功時に印字する checkpoint の形。 参加者が「自分で選んだ
 * 問題 id」を含むので固定文字列では判定できず、 形だけを regex で確認する。
 */
const CUSTOM_CHALLENGE_CHECKPOINT = /^tc\{custom-challenge:([a-z0-9]+(?:-[a-z0-9]+)*)\}$/i;

/**
 * 雛形 (`pack init`) と golden reference の id。 これらを提出した場合は「2 問目を
 * 自分で作った」ことにならないので checkpoint として受け付けない。
 */
const RESERVED_CUSTOM_CHALLENGE_IDS = new Set(["hello-world", "golden-basic-find-the-flag"]);

function matchesCustomChallengeCheckpoint(rawFlag: string): boolean {
  const match = rawFlag.trim().match(CUSTOM_CHALLENGE_CHECKPOINT);
  if (!match) return false;
  return !RESERVED_CUSTOM_CHALLENGE_IDS.has(match[1].toLowerCase());
}

/**
 * #2711 follow-up: 厳密判定のオンボーディングドリルか。 これらの問題では
 * 「`tenkacloudsample` で正解を体験できる」 という緩い demo 判定のヘルパー文言を
 * 出さない (従うと wrong になる誤案内のため)。
 *
 * Issue #2781: 以前は問題 id を手書きで列挙していたため、 `QUIZ_ANSWERS` に厳密解答を
 * 持つ `ai-agent-local-mac` が漏れ、 採点は厳密なのに入力欄には緩い案内が出ていた。
 * 判定を `QUIZ_ANSWERS` から導出し、 専用 matcher しか持たないドリル (Lite デプロイ /
 * Lite 片付け) だけを明示的に足すことで、 この契約ずれが再発しないようにする。
 */
export function isStrictDrillProblem(problemId: string): boolean {
  return (
    // Object.hasOwn: `toString` 等の prototype key を厳密ドリルと誤判定させない。
    Object.hasOwn(QUIZ_ANSWERS, problemId) ||
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
 * 問題まるごとを専用 checkpoint で判定するドリル (どの sub-flag も同じ matcher が見る)。
 * Map なので `toString` 等の prototype key が matcher として引かれることはない。
 */
const PROBLEM_MATCHERS = new Map<string, (flagId: string, rawFlag: string) => boolean>([
  [LITE_DRILL_PROBLEM_ID, matchesLiteDrillCheckpoint],
  [LITE_CLEANUP_DRILL_PROBLEM_ID, matchesLiteCleanupDrillCheckpoint],
]);

/**
 * 特定の sub-flag だけ専用判定で、 残りの sub-flag は `QUIZ_ANSWERS` へ落ちるドリル。
 * ローカル起動コマンドと、 参加者ごとに id が変わる独自問題 checkpoint がこれにあたる。
 */
const FLAG_MATCHERS = new Map<string, (rawFlag: string) => boolean>([
  [
    `${LOCAL_DRILL_PROBLEM_ID}/${LOCAL_DRILL_LAUNCH_COMMAND.flagId}`,
    matchesLocalDrillLaunchCommand,
  ],
  [
    `${CUSTOM_CHALLENGE_PROBLEM_ID}/${CUSTOM_CHALLENGE_VERIFIED_FLAG_ID}`,
    matchesCustomChallengeCheckpoint,
  ],
]);

/**
 * ドリルとしての判定結果。 `undefined` は「厳密ドリルではない」= 汎用判定へ falls back。
 * 判定順は 問題専用 → sub-flag 専用 → クイズ解答表 の順で、 従来の if 連鎖と同じ。
 */
function matchesDrill(problemId: string, flagId: string, rawFlag: string): boolean | undefined {
  const byProblem = PROBLEM_MATCHERS.get(problemId);
  if (byProblem) return byProblem(flagId, rawFlag);
  const byFlag = FLAG_MATCHERS.get(`${problemId}/${flagId}`);
  if (byFlag) return byFlag(rawFlag);
  if (Object.hasOwn(QUIZ_ANSWERS, problemId)) {
    return matchesQuizAnswer(problemId, flagId, rawFlag);
  }
  return undefined;
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
  const drillMatch = matchesDrill(problemId, flagId, rawFlag);
  if (drillMatch !== undefined) return drillMatch ? ok() : wrong();
  const trimmed = rawFlag.trim().toLowerCase();
  return isCanonicalMatch(trimmed) || isEasterEgg(trimmed) ? ok() : wrong();
}
