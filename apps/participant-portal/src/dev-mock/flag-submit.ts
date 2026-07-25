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

const mockProblemScores = new Map<string, number>();
const mockWrongCounts = new Map<string, number>();

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

export const WHAT_IS_DRILL_PROBLEM_ID = "what-is-tenkacloud";
export const AI_AGENT_LOCAL_DRILL_PROBLEM_ID = "ai-agent-local-mac";
export const CUSTOM_CHALLENGE_PROBLEM_ID = "add-custom-challenge";
export const CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID = "problem-count";
export const CUSTOM_CHALLENGE_VERIFIED_FLAG_ID = "custom-challenge-verified";

export const LITE_DRILL_JOB_ID = "01HZX0KZZ3DR0PW9M4Q7XV2C5D";
export const LOCAL_DRILL_JOB_ID = "01HZX0M1L0CALPLAYTENKA0002";

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
      "always-on",
      "alwayson",
      "always on",
      "always-on モード",
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
  [CUSTOM_CHALLENGE_PROBLEM_ID]: {
    [CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID]: ["2"],
  },
};

const CUSTOM_CHALLENGE_CHECKPOINT = /^tc\{custom-challenge:([a-z0-9]+(?:-[a-z0-9]+)*)\}$/i;
const RESERVED_CUSTOM_CHALLENGE_IDS = new Set(["hello-world", "golden-basic-find-the-flag"]);

function matchesCustomChallengeCheckpoint(rawFlag: string): boolean {
  const match = rawFlag.trim().match(CUSTOM_CHALLENGE_CHECKPOINT);
  if (!match) return false;
  return !RESERVED_CUSTOM_CHALLENGE_IDS.has(match[1].toLowerCase());
}

export function isStrictDrillProblem(problemId: string): boolean {
  return (
    problemId === LITE_CLEANUP_DRILL_PROBLEM_ID ||
    problemId === LITE_DRILL_PROBLEM_ID ||
    problemId === LOCAL_DRILL_PROBLEM_ID ||
    problemId in QUIZ_ANSWERS
  );
}

function matchesQuizAnswer(problemId: string, flagId: string, rawFlag: string): boolean {
  const answers = QUIZ_ANSWERS[problemId]?.[flagId];
  if (!answers) return false;
  return answers.includes(rawFlag.trim().toLowerCase());
}

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
  if (
    problemId === CUSTOM_CHALLENGE_PROBLEM_ID &&
    flagId === CUSTOM_CHALLENGE_VERIFIED_FLAG_ID
  ) {
    return matchesCustomChallengeCheckpoint(rawFlag) ? ok() : wrong();
  }
  if (QUIZ_ANSWERS[problemId]) {
    return matchesQuizAnswer(problemId, flagId, rawFlag) ? ok() : wrong();
  }
  const trimmed = rawFlag.trim().toLowerCase();
  return isCanonicalMatch(trimmed) || isEasterEgg(trimmed) ? ok() : wrong();
}
