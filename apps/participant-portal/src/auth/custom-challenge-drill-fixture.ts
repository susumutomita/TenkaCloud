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
      "最後は、問題を **解く側から作る側** へ進む。",
      "",
      "Problem Pack は問題をまとめた 1 つのフォルダで、問題 1 問は 2 ファイルでできている。",
      "",
      "- `metadata.json` — 問題の id / タイトル / 説明 / ヒント / 採点方法",
      "- `template.yaml` — デプロイされる CloudFormation。flag はこの中の Outputs で出す",
      "",
      "雛形には `hello-world` が 1 問だけ入っている。これを **消さずに残したまま**、2 問目として自分の Challenge を足す。書き換えではなく「足す」のがポイントで、カタログに問題が 1 問増えるとはどういうことかを一度自分の手で通しておく。",
      "",
      "#### 手順",
      "",
      '1. `make pack-init ARGS="./my-first-pack"` で雛形を作る (`hello-world` が 1 問できる)',
      "2. golden の `find-the-flag` を 2 問目のフォルダとしてコピーする",
      "3. コピーした 2 問目を自分のものに書き換える (書き換える項目はヒント 2 に全部並べてある)",
      "4. `bun run onboarding:verify-custom-challenge ./my-first-pack` を通す",
      "",
      "#### チェックポイント",
      "",
      "1. 標準 validator が通した Problem 数を答える",
      "2. verifier が印字した checkpoint を提出する",
      "",
      "AWS 資格情報もネットワークも不要。手元の Mac でも GitHub Codespaces でも完結する。ヒントは 3 つともペナルティなしで開けるので、詰まったら先に開いてよい。",
    ].join("\n"),
    instructions: [
      "```bash",
      "# 1. 雛形を作る (hello-world が 1 問できる)",
      'make pack-init ARGS="./my-first-pack"',
      "",
      "# 2. golden を 2 問目としてコピーする。フォルダ名が自分の問題 id になる",
      "cp -r packs/golden/basic-aws-pack/problems/challenges/find-the-flag \\",
      "      ./my-first-pack/problems/challenges/find-the-forgotten-bucket",
      "",
      "# 3. コピーした metadata.json と template.yaml を自分のものに書き換える",
      "#    (書き換える項目の一覧はヒント 2)",
      "",
      "# 4. 検証する。成功すると Checkpoint: が出る",
      "bun run onboarding:verify-custom-challenge ./my-first-pack",
      "```",
      "",
      "`find-the-forgotten-bucket` は例。自分の問題 id に置き換えてよいが、**フォルダ名と `metadata.json` の `id` は必ず一致させる**。",
    ].join("\n"),
    i18n: {
      en: {
        name: "Add your own challenge",
        description: [
          "Finish by moving from **problem solver to problem author**.",
          "",
          "A Problem Pack is one folder holding problems, and each problem is two files:",
          "",
          "- `metadata.json` — the problem's id, title, description, hints and scoring",
          "- `template.yaml` — the CloudFormation that gets deployed. The flag comes out of its Outputs",
          "",
          "The scaffold contains exactly one problem, `hello-world`. **Keep it**, and add your own Challenge as a second problem. Adding rather than rewriting is the point: go through, once and by hand, what it takes for a catalog to grow by one problem.",
          "",
          "#### Steps",
          "",
          '1. `make pack-init ARGS="./my-first-pack"` scaffolds the pack (one problem, `hello-world`)',
          "2. Copy the golden `find-the-flag` in as a second problem folder",
          "3. Rewrite that copy as your own (hint 2 lists every field you must change)",
          "4. Get `bun run onboarding:verify-custom-challenge ./my-first-pack` to pass",
          "",
          "#### Checkpoints",
          "",
          "1. Submit how many problems the standard validator accepted",
          "2. Submit the checkpoint printed by the verifier",
          "",
          "No AWS credentials or network access required. It runs entirely on your Mac or in GitHub Codespaces. All three hints are penalty-free, so open them early if you are stuck.",
        ].join("\n"),
        instructions: [
          "```bash",
          "# 1. Scaffold the pack (one problem, hello-world)",
          'make pack-init ARGS="./my-first-pack"',
          "",
          "# 2. Copy the golden challenge in as the second problem.",
          "#    The folder name becomes your problem id.",
          "cp -r packs/golden/basic-aws-pack/problems/challenges/find-the-flag \\",
          "      ./my-first-pack/problems/challenges/find-the-forgotten-bucket",
          "",
          "# 3. Rewrite the copied metadata.json and template.yaml as your own",
          "#    (hint 2 lists every field)",
          "",
          "# 4. Verify. On success it prints Checkpoint:",
          "bun run onboarding:verify-custom-challenge ./my-first-pack",
          "```",
          "",
          "`find-the-forgotten-bucket` is only an example — use any id you like, but the **folder name and `metadata.json`'s `id` must match exactly**.",
        ].join("\n"),
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
              content: [
                "verifier が見ている条件は次の 8 つ。上から順に潰せば通る。",
                "",
                "1. Problem が 2 問あり、`hello-world` が残っている (消さない)",
                "2. 2 問目のフォルダが `problems/challenges/<id>` で、`metadata.json` の `id` と一致する",
                "3. `id` は kebab-case (`find-the-forgotten-bucket` のような英小文字とハイフン)",
                "4. `category` が `challenges`",
                "5. `title` と `description` が golden のままでない (自分の文言にする)",
                "6. `scoring.hints` の 1 つ目が golden のままでない",
                "7. `scoring.kind` が `flag` で、`scoring.flagOutputKey` の名前が `template.yaml` の `Outputs` に存在する",
                "8. `template.yaml` に golden の flag 値 `TENKA{golden-reference-flag}` が残っていない",
                "",
                "`runtime` (`aws` / `cloudformation` / `template.yaml`) は触らずそのままにする。",
              ].join("\n"),
              i18n: {
                en: {
                  content: [
                    "The verifier checks these eight things. Work down the list and it will pass.",
                    "",
                    "1. There are 2 problems and `hello-world` is still there (do not delete it)",
                    "2. The second problem's folder is `problems/challenges/<id>` and matches `id` in `metadata.json`",
                    "3. `id` is kebab-case (lowercase letters and hyphens, e.g. `find-the-forgotten-bucket`)",
                    "4. `category` is `challenges`",
                    "5. `title` and `description` are no longer the golden ones (make them yours)",
                    "6. The first entry in `scoring.hints` is no longer the golden one",
                    "7. `scoring.kind` is `flag`, and the name in `scoring.flagOutputKey` exists in `Outputs` in `template.yaml`",
                    "8. The golden flag value `TENKA{golden-reference-flag}` is gone from `template.yaml`",
                    "",
                    "Leave `runtime` (`aws` / `cloudformation` / `template.yaml`) exactly as it is.",
                  ].join("\n"),
                },
              },
            },
            {
              id: "custom-challenge-h3",
              penalty: 0,
              revealed: false,
              content: [
                "よく落ちるのはこの 2 つ。",
                "",
                "- **フォルダ名だけ変えて `metadata.json` の `id` を直し忘れる** — `directory must be problems/challenges/<metadata.id>` が出る。両方を同じ文字列にする。",
                "- **`template.yaml` の flag を書き換えていない** — `replace the golden reference flag with your own value` が出る。`TENKA{...}` の中身を自分の値にする。",
                "",
                "verifier は落ちた条件を `パス: 理由` の形で全部並べて出すので、1 つずつ消していけばよい。全部通ると `Checkpoint: TC{CUSTOM-CHALLENGE:<自分のid>}` が出るので、その行の値をそのまま提出する。",
              ].join("\n"),
              i18n: {
                en: {
                  content: [
                    "These two account for most failures.",
                    "",
                    "- **Renaming the folder but forgetting `id` in `metadata.json`** — you get `directory must be problems/challenges/<metadata.id>`. Make both the same string.",
                    "- **Leaving the flag in `template.yaml` untouched** — you get `replace the golden reference flag with your own value`. Put your own value inside `TENKA{...}`.",
                    "",
                    "The verifier prints every unmet condition as `path: reason`, so clear them one at a time. Once they all pass it prints `Checkpoint: TC{CUSTOM-CHALLENGE:<your-id>}` — submit that value.",
                  ].join("\n"),
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
