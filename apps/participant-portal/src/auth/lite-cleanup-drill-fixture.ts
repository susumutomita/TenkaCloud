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
    videoUrl: "https://www.youtube.com/embed/sRUn3Tzu4UM",
    name: "TenkaCloud を片付ける",
    description: [
      "デプロイした TenkaCloud には継続費用が発生する。遊び終わったら、**Cloud 基盤と launcher の両方**を削除して課金を止める。",
      "この問題はデプロイ問題とは別の片付け編。CodeBuild の削除成功ログに現れるチェックポイントを控え、launcher 削除後に提出する。",
      "チェックポイントが確認できるのは Cloud 基盤の削除成功まで。launcher の削除はシステムから観測できないため、CloudFormation の削除完了を自分で確認してから提出する。",
      "",
      "既存動画と採点コードは旧版の例。現行 cloud-pipeline では完了ログと残存リソースを確認し、旧 Cleanup checkpoint の出力は保証しない。",
      "#### 片付ける前に",
      "問題環境は大会の Teardown で先に撤収する。make destroy は外部 Turso の行を保持し、make destroy-all は確認後に保持データも削除する。source bucket などの残存リソースは別途確認する。",
      "",
      "- イベントや問題で必要な結果を保存したことを確認する",
      "- 削除する AWS アカウントと Environment が、デプロイ時と同じことを確認する",
      "- 削除処理を途中で止めず、CodeBuild が成功するまでログを確認する",
      "",
      "#### 進め方",
      "",
      "1. launcher スタックの `StartBuildConsoleUrl` から CodeBuild を開く",
      "2. **Start build with overrides** を選び、環境変数 `ACTION=destroy-all` を指定して開始する",
      "3. 選択した DB と所有する保持データの削除の成功ログで、チェックポイントコードを控える",
      "4. CloudFormation で launcher スタック自体を削除する(CodeBuild project、IAM Role、launcher のログも削除される)",
      "5. launcher の削除完了を確認してから、控えたコードを下へ提出する",
      "",
      "途中で失敗した場合は launcher を先に消さず、同じ override で再実行する。launcher は片付けを再試行するための最後の手段なので、必ず最後に削除する。",
    ].join("\n"),
    instructions:
      "CodeBuild を ACTION=destroy-all で成功させ、チェックポイントを控えてから launcher スタックを削除し、最後にコードを提出する。",
    i18n: {
      en: {
        videoUrl: "https://www.youtube.com/embed/BOrIywCb_KU",
        name: "Clean up TenkaCloud",
        description: [
          "A deployed TenkaCloud keeps incurring cost. When you are done, remove **both the Cloud platform and launcher** to stop the charges.",
          "This is a separate cleanup problem. Save the checkpoint from the successful CodeBuild teardown log, delete the launcher, then submit the code.",
          "The checkpoint proves only that Cloud teardown succeeded. Launcher deletion is not observable by the demo, so self-confirm the CloudFormation deletion before submitting.",
          "",
          "Existing footage and scored codes are legacy examples. The current cloud-pipeline confirms completion and remaining resources; it does not guarantee the old Cleanup checkpoint output.",
          "#### Before cleanup",
          "Teardown event exercises first. make destroy preserves external Turso rows; make destroy-all confirms removal of retained data too. Review remaining resources such as the source bucket separately.",
          "",
          "- Confirm that you saved any event or problem results you need",
          "- Confirm the AWS account and Environment match the original deployment",
          "- Keep the logs open until CodeBuild succeeds; do not interrupt deletion",
          "",
          "#### Steps",
          "",
          "1. Open CodeBuild from the launcher stack's `StartBuildConsoleUrl`",
          "2. Choose **Start build with overrides**, set the environment override `ACTION=destroy-all`, and start",
          "3. Copy the checkpoint from the successful complete-teardown log after selected DB and owned retained data are removed",
          "4. Delete the launcher stack itself in CloudFormation (this also removes its CodeBuild project, IAM Role, and launcher log group)",
          "5. After the launcher deletion completes, submit the code you copied below",
          "",
          "If teardown fails, keep the launcher and rerun the same override. The launcher is your recovery path, so always delete it last.",
        ].join("\n"),
        instructions:
          "Run CodeBuild successfully with ACTION=destroy-all, save the checkpoint, delete the launcher stack, then submit the code.",
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
          label: "Cloud 基盤削除成功コード（launcher 削除後に提出）",
          points: 100,
          solved: false,
          i18n: { en: { label: "Cloud teardown code (submit after launcher deletion)" } },
          hints: [
            {
              id: "lite-cleanup-h1",
              penalty: 0,
              revealed: false,
              content:
                "CodeBuild の **Start build with overrides** で `ACTION=destroy-all` を指定する。選択した DB・所有する保持データの削除の成功ログで `Cleanup checkpoint` を控え、CloudFormation で launcher スタックの削除完了を確認してから、そのコードを提出する。失敗時は launcher を残して再実行する。",
              i18n: {
                en: {
                  content:
                    "Use **Start build with overrides** in CodeBuild and set `ACTION=destroy-all`. Save the `Cleanup checkpoint` after the log confirms teardown of the selected database and owned retained data, confirm the launcher stack is deleted in CloudFormation, then submit that code. Keep the launcher and retry if teardown fails.",
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
