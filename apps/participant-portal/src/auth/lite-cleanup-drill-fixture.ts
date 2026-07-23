import {
  LITE_CLEANUP_DRILL_CHECKPOINT,
  LITE_CLEANUP_DRILL_PROBLEM_ID,
  type ParticipantProblemView,
} from "@tenkacloud/portal-contracts";

interface LiteCleanupDrillFixtureOptions {
  readonly createdAt: string;
  readonly expiresAt: number;
}

export function createLiteCleanupDrillFixture({
  createdAt,
  expiresAt,
}: LiteCleanupDrillFixtureOptions): ParticipantProblemView {
  return {
    jobId: "01HZX0M0CLEANUPTENKA0001",
    problemId: LITE_CLEANUP_DRILL_PROBLEM_ID,
    name: "TenkaCloud Lite を片付ける",
    description: [
      "デプロイした TenkaCloud Lite には継続費用が発生する。遊び終わったら、**Lite 本体と launcher の両方**を削除して課金を止める。",
      "この問題はデプロイ問題とは別の片付け編。CodeBuild の削除成功ログに現れるチェックポイントを控え、launcher 削除後に提出する。",
      "チェックポイントが確認できるのは Lite 本体の削除成功まで。launcher の削除はシステムから観測できないため、CloudFormation の削除完了を自分で確認してから提出する。",
      "",
      "#### 片付ける前に",
      "",
      "- イベントや問題で必要な結果を保存したことを確認する",
      "- 削除する AWS アカウントと Environment が、デプロイ時と同じことを確認する",
      "- 削除処理を途中で止めず、CodeBuild が成功するまでログを確認する",
      "",
      "#### 進め方",
      "",
      "1. launcher スタックの `StartBuildConsoleUrl` から CodeBuild を開く",
      "2. **Start build with overrides** を選び、環境変数 `ACTION=destroy` を指定して開始する",
      "3. 削除成功ログに出るチェックポイントコードを控える",
      "4. CloudFormation で launcher スタック自体を削除する(CodeBuild project と IAM Role も削除される)",
      "5. launcher の削除完了を確認してから、控えたコードを下へ提出する",
      "",
      "途中で失敗した場合は launcher を先に消さず、同じ override で再実行する。launcher は片付けを再試行するための最後の手段なので、必ず最後に削除する。",
    ].join("\n"),
    instructions:
      "CodeBuild を ACTION=destroy で成功させ、チェックポイントを控えてから launcher スタックを削除し、最後にコードを提出する。",
    i18n: {
      en: {
        name: "Clean up TenkaCloud Lite",
        description: [
          "A deployed TenkaCloud Lite keeps incurring cost. When you are done, remove **both Lite itself and the launcher** to stop the charges.",
          "This is a separate cleanup problem. Save the checkpoint from the successful CodeBuild teardown log, delete the launcher, then submit the code.",
          "The checkpoint proves only that Lite teardown succeeded. Launcher deletion is not observable by the demo, so self-confirm the CloudFormation deletion before submitting.",
          "",
          "#### Before cleanup",
          "",
          "- Confirm that you saved any event or problem results you need",
          "- Confirm the AWS account and Environment match the original deployment",
          "- Keep the logs open until CodeBuild succeeds; do not interrupt deletion",
          "",
          "#### Steps",
          "",
          "1. Open CodeBuild from the launcher stack's `StartBuildConsoleUrl`",
          "2. Choose **Start build with overrides**, set the environment override `ACTION=destroy`, and start",
          "3. Copy the checkpoint printed in the successful teardown log",
          "4. Delete the launcher stack itself in CloudFormation (this also removes its CodeBuild project and IAM Role)",
          "5. After the launcher deletion completes, submit the code you copied below",
          "",
          "If teardown fails, keep the launcher and rerun the same override. The launcher is your recovery path, so always delete it last.",
        ].join("\n"),
        instructions:
          "Run CodeBuild successfully with ACTION=destroy, save the checkpoint, delete the launcher stack, then submit the code.",
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
          id: LITE_CLEANUP_DRILL_CHECKPOINT.flagId,
          label: "Lite 削除成功コード（launcher 削除後に提出）",
          points: 100,
          solved: false,
          i18n: { en: { label: "Lite teardown code (submit after launcher deletion)" } },
          hints: [
            {
              id: "lite-cleanup-h1",
              penalty: 0,
              revealed: false,
              content:
                "CodeBuild の **Start build with overrides** で `ACTION=destroy` を指定する。成功ログの `Cleanup checkpoint` を控え、CloudFormation で launcher スタックの削除完了を確認してから、そのコードを提出する。失敗時は launcher を残して再実行する。",
              i18n: {
                en: {
                  content:
                    "Use **Start build with overrides** in CodeBuild and set `ACTION=destroy`. Save the `Cleanup checkpoint` from the success log, confirm the launcher stack is deleted in CloudFormation, then submit that code. Keep the launcher and retry if teardown fails.",
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
