import type { ParticipantProblemView } from "@tenkacloud/portal-contracts";
import {
  CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
  CUSTOM_CHALLENGE_PROBLEM_ID,
  CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
} from "../dev-mock/flag-submit";

interface CustomChallengeDrillFixtureOptions {
  readonly createdAt: string;
  readonly expiresAt: number;
}

/**
 * Issue #2781: 自己解説型オンボーディングの 6 問目 (最終問題)。
 *
 * 1〜5 問目は「問題を解く」体験だが、この問題だけは **問題を作る側へ移る**。参加者は
 * `pack init` で Problem Pack を作り、雛形の `hello-world` を残したまま 2 問目として
 * 独自の flag-scored Challenge を追加し、標準 validator とチュートリアル専用 verifier を
 * 通したチェックポイントを提出する。
 *
 * fixture を別 module に切り出しているのは `lite-cleanup-drill-fixture` と同じ理由で、
 * `dev-mock-fixtures.ts` を 1 ファイルの上限内に保つため。
 */
export function createCustomChallengeDrillFixture({
  createdAt,
  expiresAt,
}: CustomChallengeDrillFixtureOptions): ParticipantProblemView {
  return {
    jobId: "01HZX0M3CUSTOMCHALLENGE0006",
    problemId: CUSTOM_CHALLENGE_PROBLEM_ID,
    name: "独自問題を追加する",
    description: [
      "最後は、問題を **解く側から作る側** へ進む。Problem Pack を作り、雛形の `hello-world` を残したまま、2 問目として独自の flag-scored Challenge を追加する。",
      "既存問題を書き換えるのではなく「足す」のがポイント。カタログに問題が増えるとはどういうことかを、自分の手で一度体験しておく。",
      "",
      "#### チェックポイント",
      "",
      "1. 標準 validator が通した Problem 数を答える",
      "2. チュートリアル専用 verifier が印字した checkpoint を提出する",
      "",
      "AWS 資格情報もネットワークも不要。手元の Mac でも GitHub Codespaces でも完結する。ヒントはペナルティなしで開ける。",
    ].join("\n"),
    instructions:
      '`make pack-init ARGS="./my-first-pack"` で雛形を作り、golden Challenge を 2 問目としてコピーして自分の問題に書き換え、`bun run onboarding:verify-custom-challenge ./my-first-pack` を通す。',
    i18n: {
      en: {
        name: "Add your own challenge",
        description: [
          "Finish by moving from **problem solver to problem author**. Create a Problem Pack, keep the scaffolded `hello-world`, and add your own flag-scored Challenge as the second problem.",
          "The point is adding rather than rewriting: experience once, first-hand, what it means for a catalog to grow by one problem.",
          "",
          "#### Checkpoints",
          "",
          "1. Submit how many problems the standard validator accepted",
          "2. Submit the checkpoint printed by the tutorial verifier",
          "",
          "No AWS credentials or network access required. It runs entirely on your Mac or in GitHub Codespaces. Hints are penalty-free.",
        ].join("\n"),
        instructions:
          'Run `make pack-init ARGS="./my-first-pack"`, copy the golden Challenge as the second problem, rewrite it as your own, and get `bun run onboarding:verify-custom-challenge ./my-first-pack` to pass.',
      },
    },
    region: "ap-northeast-1",
    awsAccountId: "999999999999",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt,
    score: 0,
    scoring: {
      kind: "multi-flag",
      flags: [
        {
          id: CUSTOM_CHALLENGE_PROBLEM_COUNT_FLAG_ID,
          label: "1. validate を通過した Problem 数は?",
          points: 100,
          solved: false,
          i18n: { en: { label: "1. How many problems passed validation?" } },
          hints: [
            {
              id: "custom-challenge-h1",
              penalty: 0,
              revealed: false,
              content:
                '`make pack-init ARGS="./my-first-pack"` で雛形を作ると `hello-world` が 1 問できる。これを消さずに、`packs/golden/basic-aws-pack/problems/challenges/find-the-flag` を 2 問目としてコピーする。`make pack-validate ARGS="./my-first-pack"` の成功表示に出る Problem 数をそのまま提出する。',
              i18n: {
                en: {
                  content:
                    'Running `make pack-init ARGS="./my-first-pack"` scaffolds one problem, `hello-world`. Keep it, and copy `packs/golden/basic-aws-pack/problems/challenges/find-the-flag` in as the second problem. Submit the problem count printed by `make pack-validate ARGS="./my-first-pack"`.',
                },
              },
            },
          ],
        },
        {
          id: CUSTOM_CHALLENGE_VERIFIED_FLAG_ID,
          label: "2. verifier が出力した checkpoint は?",
          points: 100,
          solved: false,
          i18n: { en: { label: "2. Which checkpoint did the verifier print?" } },
          hints: [
            {
              id: "custom-challenge-h2",
              penalty: 0,
              revealed: false,
              content:
                "2 問目の `metadata.json` の `id` / `title` / `description` / ヒント、`template.yaml` の flag 値を自分のものに書き換えてから `bun run onboarding:verify-custom-challenge ./my-first-pack` を実行する。成功時に出る `Checkpoint:` の値をそのまま貼り付ける (雛形のままの id では通らない)。",
              i18n: {
                en: {
                  content:
                    "Rewrite the second problem's `id` / `title` / `description` / hint in `metadata.json` and the flag value in `template.yaml` to your own, then run `bun run onboarding:verify-custom-challenge ./my-first-pack`. Paste the `Checkpoint:` value it prints on success (the untouched scaffold id will not pass).",
                },
              },
            },
          ],
        },
      ],
    },
    deployLog: { cursor: "", entries: [] },
    createdAt,
  };
}
