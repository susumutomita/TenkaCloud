import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
} from "../api/portal-client";
import {
  CUSTOM_CHALLENGE_PROBLEM_ID,
  CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
  CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
} from "../dev-mock/flag-submit";
import {
  DEV_MOCK_LEADERBOARD,
  DEV_MOCK_NOTIFICATIONS,
  DEV_MOCK_TEAM_VIEW,
} from "./dev-mock-fixtures";

/**
 * Issue #2781: append the final authoring challenge without duplicating the large
 * base fixture. This module is imported once by main.tsx before the React tree is
 * rendered, so every dev-mock consumer observes the same six-problem journey.
 */
const customChallenge = {
  jobId: "01HZX0M3CUSTOMCHALLENGETC06",
  problemId: CUSTOM_CHALLENGE_PROBLEM_ID,
  name: "独自問題を追加する",
  description: [
    "最後は、問題を解く側から作る側へ進む。Problem Packを作成し、既存の`hello-world`を残したまま、2問目として独自のflag-scored Challengeを追加する。",
    "",
    "#### 完了条件",
    "",
    "1. `bun run onboarding:verify-custom-challenge ./my-first-pack` が成功する",
    "2. verifierが表示したProblem数とcheckpointを提出する",
    "",
    "AWS資格情報とネットワークは不要。ローカルまたはGitHub Codespacesで完結する。",
  ].join("\n"),
  instructions:
    "`make pack-init ARGS=\"./my-first-pack\"`で雛形を作り、golden Challengeを2問目としてコピー・編集・検証する。",
  i18n: {
    en: {
      name: "Add your own challenge",
      description: [
        "Finish by moving from problem solver to problem author. Create a Problem Pack, keep the existing `hello-world`, and add your own flag-scored Challenge as the second problem.",
        "",
        "#### Completion criteria",
        "",
        "1. `bun run onboarding:verify-custom-challenge ./my-first-pack` succeeds",
        "2. Submit the problem count and checkpoint printed by the verifier",
        "",
        "No AWS credentials or network access are required. The exercise runs locally or in GitHub Codespaces.",
      ].join("\n"),
      instructions:
        "Run `make pack-init ARGS=\"./my-first-pack\"`, copy the golden Challenge as the second problem, customize it, and validate it.",
    },
  },
  region: "ap-northeast-1",
  awsAccountId: "999999999999",
  status: "COMPLETE" as const,
  stackOutputs: {},
  score: 0,
  scoring: {
    kind: "multi-flag" as const,
    flags: [
      {
        id: CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
        label: "1. validateを通過したProblem数は?",
        points: 100,
        solved: false,
        i18n: { en: { label: "1. How many problems passed validation?" } },
        hints: [
          {
            id: "custom-challenge-count-h1",
            penalty: 0,
            revealed: false,
            content:
              "`hello-world`を削除せず、`packs/golden/basic-aws-pack/problems/challenges/find-the-flag`を2問目としてコピーする。標準validatorの成功表示に出るProblem数を提出する。",
            i18n: {
              en: {
                content:
                  "Keep `hello-world`, copy `packs/golden/basic-aws-pack/problems/challenges/find-the-flag` as the second problem, and submit the count printed by the standard validator.",
              },
            },
          },
        ],
      },
      {
        id: CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
        label: "2. verifierが出力したcheckpoint",
        points: 100,
        solved: false,
        i18n: { en: { label: "2. Checkpoint printed by the verifier" } },
        hints: [
          {
            id: "custom-challenge-verified-h1",
            penalty: 0,
            revealed: false,
            content:
              "`bun run onboarding:verify-custom-challenge ./my-first-pack`を実行する。成功時の`Checkpoint:`行をそのまま貼り付ける。",
            i18n: {
              en: {
                content:
                  "Run `bun run onboarding:verify-custom-challenge ./my-first-pack` and paste the successful `Checkpoint:` value exactly.",
              },
            },
          },
        ],
      },
    ],
  },
  deployLog: { cursor: "", entries: [] },
  createdAt: new Date().toISOString(),
};

const mutableProblems = DEV_MOCK_TEAM_VIEW.problems as ParticipantTeamView["problems"] extends readonly (
  infer Problem
)[]
  ? Problem[]
  : never;
if (!mutableProblems.some((problem) => problem.problemId === CUSTOM_CHALLENGE_PROBLEM_ID)) {
  mutableProblems.push(customChallenge);
}

for (const entry of DEV_MOCK_LEADERBOARD.entries as Array<
  LeaderboardResponse["entries"][number]
>) {
  (entry as { totalProblems: number }).totalProblems = mutableProblems.length;
}

const mutableNotifications = DEV_MOCK_NOTIFICATIONS.items as Array<
  NotificationsResponse["items"][number]
>;
if (!mutableNotifications.some((item) => item.notificationId === "notif-custom-challenge")) {
  mutableNotifications.unshift({
    notificationId: "notif-custom-challenge",
    title: "最終Challengeを開放",
    body: "6問目「独自問題を追加する」で、Problem Packに2問目のChallengeを追加しよう。",
    severity: "info",
    occurredAt: new Date().toISOString(),
  });
}
