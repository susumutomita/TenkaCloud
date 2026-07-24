/**
 * Zundamon voice-over scripts for recorded TenkaCloud Lite deploy and cleanup footage.
 *
 * These lines are intentionally separate from script-data.ts because the LP/problem videos can be
 * edited from real screen recordings while the slide scripts remain the generated fallback.
 * The timing windows are editor guidance for cutting the deploy and cleanup recordings separately.
 */

export type VoiceoverLocale = "ja" | "en";

export interface VoiceoverCue {
  /** Human-readable edit section, not a subtitle timestamp. */
  readonly section: string;
  /** Always-visible operation label burned into the video. */
  readonly heading: Record<VoiceoverLocale, string>;
  /** Target voice length in seconds for one locale. */
  readonly targetS: number;
  readonly ja: string;
  readonly en: string;
  /** Generated cards replace the recording before returning to the matching real operation. */
  readonly layout?: "intro" | "start" | "explainer" | "complete";
  /** Controls cleanup-specific card labels without changing the official AWS terminology. */
  readonly theme?: "deployment" | "cleanup";
  /** Moves a caption away from the operation target when the target is near the bottom edge. */
  readonly captionPlacement?: "bottom" | "top-right";
  /** Short code-grounded facts shown on the intro card. */
  readonly details?: Record<VoiceoverLocale, readonly string[]>;
  /** Supporting prerequisite shown with the operation, but not read as the main narration. */
  readonly note?: Record<VoiceoverLocale, string>;
}

export interface VoiceoverScript {
  readonly id: string;
  readonly title: Record<VoiceoverLocale, string>;
  readonly voice: Record<VoiceoverLocale, string>;
  readonly music: string;
  readonly usage: readonly string[];
  readonly cues: readonly VoiceoverCue[];
}

export const DEPLOY_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER: VoiceoverScript = {
  id: "deploy-tenkacloud-lite-zundamon",
  title: {
    ja: "TenkaCloud Lite をデプロイするのだ",
    en: "Deploy TenkaCloud Lite",
  },
  voice: {
    ja: "VOICEVOX:ずんだもん（ノーマル）",
    en: "macOS Samantha（自然な米国英語）",
  },
  music: "なし。AWS の画面操作とナレーションを優先する。",
  usage: [
    "LP の deploy-tenkacloud-lite 問題に載せる実録動画向け。",
    "全体フローと理由を説明するスライドの直後に、対応する実機操作を置く。",
    "問題の回答画面は使わず、AWS アカウント ID、メール、URL は拡大ショットの画角外にする。",
  ],
  cues: [
    {
      section: "1. What TenkaCloud Lite is",
      heading: { ja: "自分のAWS環境へデプロイ", en: "Deploy to your AWS account" },
      targetS: 10,
      ja: "TenkaCloud Lite は、一人の主催者が自分の AWS 環境で大会を開く構成なのだ。まず全体の流れを見るのだ。",
      en: "TenkaCloud Lite lets one organizer run an event in their AWS account. Here is the whole flow.",
      layout: "intro",
      details: {
        ja: [
          "1  LiteをAWSへ導入",
          "2  競技用AWSを登録",
          "3  イベントを作成・Deploy",
          "4  Participant Portal・スコア",
        ],
        en: [
          "1  Deploy Lite to AWS",
          "2  Register competitor AWS",
          "3  Create and deploy an event",
          "4  Participant Portal and score",
        ],
      },
      note: {
        ja: "AWS上の本体: tenkacloud-lite + tenkacloud-lite-problem-deploy",
        en: "AWS stacks: tenkacloud-lite + tenkacloud-lite-problem-deploy",
      },
    },
    {
      section: "2. AWS services behind automatic deployment",
      heading: {
        ja: "AWSの自動デプロイとは",
        en: "How AWS automatic deployment works",
      },
      targetS: 5,
      ja: "CloudFormation stackからCodeBuildでCDK deployするのだ。",
      en: "The CloudFormation stack invokes CodeBuild to run CDK deploy.",
      layout: "start",
      details: {
        ja: [
          "CloudFormation stack: ひな形からAWSリソースを作る",
          "CodeBuild project: make deploy / CDK deployを実行",
          "IAM Role: ServiceRoleとして実行権限を付与",
        ],
        en: [
          "CloudFormation stack: creates resources from the template",
          "CodeBuild project: runs make deploy / CDK deploy",
          "IAM Role: attached as the CodeBuild ServiceRole",
        ],
      },
      note: {
        ja: "主な本体: S3/CloudFront（画面）・Cognito（ログイン）・Lambda/API Gateway/DynamoDB（API・データ）",
        en: "Main platform: S3/CloudFront (UI), Cognito (login), Lambda/API Gateway/DynamoDB (API and data)",
      },
    },
    {
      section: "3. Launcher stack",
      heading: {
        ja: "自動デプロイ環境を作成",
        en: "Create the automatic deployment setup",
      },
      targetS: 6,
      ja: "テンプレートをアップロードすると、自動デプロイ環境が作られるのだ。",
      en: "Upload the template so CloudFormation creates the automatic deployment setup.",
      note: {
        ja: "stack名: tenkacloud-lite-launcher／収録: AdministratorAccess（実運用は必要権限へ縮小）",
        en: "Stack: tenkacloud-lite-launcher; recording: AdministratorAccess (use least privilege in production)",
      },
    },
    {
      section: "4. CodeBuild deploy",
      heading: { ja: "自動デプロイを開始", en: "Start automatic deployment" },
      targetS: 5,
      ja: "Start build を押し、Lite の自動デプロイ成功と URL を確認するのだ。",
      en: "Press Start build, then confirm the automatic Lite deployment and its URLs.",
    },
    {
      section: "5. Admin sign-in",
      heading: { ja: "管理画面へサインイン", en: "Sign in to Admin Console" },
      targetS: 5,
      ja: "招待メールから管理画面を開くのだ。",
      en: "Open the Admin Console from the invite email.",
    },
    {
      section: "6. Why competitor AWS is separate",
      heading: { ja: "なぜ競技用AWSを分けるのか", en: "Why separate competitor AWS?" },
      targetS: 5,
      ja: "運営と競技用 AWS を分け、ExternalId 付きでつなぐのだ。",
      en: "Keep operations and competitor AWS separate, then connect them with an external I D.",
      layout: "explainer",
      details: {
        ja: ["TenkaCloud Lite", "Assume Role + ExternalId", "競技用AWS"],
        en: ["TenkaCloud Lite", "Assume Role + ExternalId", "Competitor AWS"],
      },
      note: {
        ja: "問題リソースだけを競技用AWSへ作り、信頼関係をVerifyする",
        en: "Problem resources are created in competitor AWS after the trust is verified",
      },
    },
    {
      section: "7. Competitor account",
      heading: { ja: "Competitorを登録", en: "Register a competitor" },
      targetS: 10,
      ja: "問題を競技用 AWS へ出せるように、アカウントを登録するのだ。bootstrap を作り、Verify するのだ。",
      en: "Register the competitor AWS account, create its bootstrap stack, then verify the trust.",
      note: {
        ja: "ExternalId付きAssumeRoleで競技用AWSへの信頼を確認",
        en: "Trust is verified with AssumeRole and an ExternalId",
      },
    },
    {
      section: "8. Why an event comes first",
      heading: { ja: "なぜEventを先に作るのか", en: "Why create an event first?" },
      targetS: 5,
      ja: "Event でチーム、AWS、問題を結び付けてから配るのだ。",
      en: "An event connects the team, AWS account, and problem before deployment.",
      layout: "explainer",
      details: {
        ja: ["Team + AWS + Problem", "Event Deploy", "Portal + Score"],
        en: ["Team + AWS + problem", "Event deploy", "Portal + score"],
      },
      note: {
        ja: "Eventを配布単位にすることで、参加者と問題スタックを対応付ける",
        en: "The event is the delivery unit that maps participants to problem stacks",
      },
    },
    {
      section: "9. Create event",
      heading: { ja: "イベントを作成", en: "Create an event" },
      targetS: 7,
      ja: "イベント名とチームを決め、検証済みアカウントと遊ぶ問題を選ぶのだ。",
      en: "Create an event, then assign the verified account and the problem to play.",
    },
    {
      section: "10. Event deployment",
      heading: { ja: "イベントをDeploy", en: "Deploy the event" },
      targetS: 5,
      ja: "Deploy を押し、問題スタックの準備完了を待つのだ。",
      en: "Select deploy, then wait until the problem stack is ready.",
      note: {
        ja: "問題テンプレートを競技用AWSのCloudFormation CreateStackへ渡す",
        en: "The problem template is submitted to CloudFormation CreateStack in competitor AWS",
      },
    },
    {
      section: "11. Participant sign-in",
      heading: { ja: "Participant Portalへ入る", en: "Open Participant Portal" },
      targetS: 4,
      ja: "Participant Portal に team key で入るのだ。",
      en: "Sign in to Participant Portal with the team key.",
    },
    {
      section: "12. Play the problem",
      heading: { ja: "問題をプレイ", en: "Play the problem" },
      targetS: 6,
      ja: "問題の説明を読み、回答欄から提出するのだ。答えは見せないのだ。",
      en: "Read the problem and submit through its answer field. The answer is not shown.",
    },
    {
      section: "13. Score and close",
      heading: { ja: "スコアを確認", en: "Confirm the score" },
      targetS: 4,
      ja: "Scoreboard への反映を確認して完了なのだ。",
      en: "Confirm the Scoreboard update to finish.",
    },
  ],
};

export const CLEANUP_TENKACLOUD_LITE_ZUNDAMON_VOICEOVER: VoiceoverScript = {
  id: "cleanup-tenkacloud-lite-zundamon",
  title: {
    ja: "TenkaCloud Lite を片付けるのだ",
    en: "Clean up TenkaCloud Lite",
  },
  voice: {
    ja: "VOICEVOX:ずんだもん（ノーマル）",
    en: "macOS Samantha（自然な米国英語）",
  },
  music: "Cat_life.mp3 / GT-K。ナレーションを妨げない音量でミックスする。",
  usage: [
    "LP の cleanup-tenkacloud-lite 問題に載せる実録動画向け。",
    "全体フローと削除順の理由を説明するスライドの直後に、対応する実機操作を置く。",
    "ACTION=destroy-all から launcher スタック削除までを扱い、チュートリアルの回答は見せない。",
    "AWS アカウント ID、メール、URL は黒マスクではなく拡大ショットの画角外にする。",
  ],
  cues: [
    {
      section: "1. Cleanup overview",
      heading: {
        ja: "TenkaCloud Liteを安全に片付ける",
        en: "Clean up TenkaCloud Lite safely",
      },
      targetS: 7,
      ja: "遊び終わったら、Lite本体と自動デプロイ環境を順番に削除して、AWSの継続費用を止めるのだ。",
      en: "When the event is over, remove the Lite platform and its deployment setup in this order to stop ongoing AWS costs.",
      layout: "intro",
      theme: "cleanup",
      details: {
        ja: ["1  CodeBuildでLite本体を削除", "2  削除成功を確認", "3  launcherを最後に削除"],
        en: [
          "1  Remove Lite with CodeBuild",
          "2  Confirm successful deletion",
          "3  Delete the launcher last",
        ],
      },
      note: {
        ja: "必要なイベント結果を保存してから削除する",
        en: "Save any event results you need before cleanup",
      },
    },
    {
      section: "2. Why the launcher is deleted last",
      heading: {
        ja: "なぜlauncherを最後に消すのか",
        en: "Why delete the launcher last?",
      },
      targetS: 8,
      ja: "launcherのCodeBuildがLiteを完全削除する復旧経路なのだ。先にACTION=destroy-allを実行し、launcherは最後に消すのだ。",
      en: "The launcher CodeBuild project is the recovery path that completely removes Lite. Run ACTION equals destroy all first, and delete the launcher last.",
      layout: "explainer",
      theme: "cleanup",
      details: {
        ja: ["launcher CodeBuild", "ACTION=destroy-all", "Lite resources", "launcher stack"],
        en: ["Launcher CodeBuild", "ACTION=destroy-all", "Lite resources", "Launcher stack"],
      },
      note: {
        ja: "launcherを先に消すと、同じパイプラインからLite本体を削除できない",
        en: "Deleting the launcher first removes the pipeline used to clean up Lite",
      },
    },
    {
      section: "3. Build with ACTION=destroy-all",
      heading: { ja: "削除ビルドを開始", en: "Start the cleanup build" },
      targetS: 4,
      ja: "CodeBuildでACTION=destroy-allにして、ビルドを開始するのだ。",
      en: "In CodeBuild, set ACTION to destroy all and start the build.",
      layout: "explainer",
      theme: "cleanup",
      details: {
        ja: ["CodeBuild", "DynamoDB", "CloudWatch Logs", "Lite stacks"],
        en: ["CodeBuild", "DynamoDB", "CloudWatch Logs", "Lite stacks"],
      },
      note: {
        ja: "古いlauncherは、先に最新テンプレートへ更新する",
        en: "Update an older launcher to the latest template first",
      },
    },
    {
      section: "4. Teardown progress",
      heading: { ja: "Liteの削除を確認", en: "Confirm Lite teardown" },
      targetS: 8,
      ja: "destroy-allはDynamoDBとログ、Lite本体とproblem-deployのstackを削除するのだ。CloudFormationで進行を確認するのだ。",
      en: "Destroy all removes DynamoDB data and logs, then the TenkaCloud Lite and problem deploy stacks. Follow the progress in CloudFormation.",
    },
    {
      section: "5. Delete launcher",
      heading: { ja: "Launcherを削除", en: "Delete the launcher" },
      targetS: 9,
      ja: "最後にCloudFormationでlauncher stackを削除するのだ。これでCodeBuild project、IAM Role、launcherのログも削除されるのだ。",
      en: "Finally, delete the launcher stack in CloudFormation. This also removes its CodeBuild project, IAM role, and launcher log group.",
    },
    {
      section: "6. Confirm cleanup complete",
      heading: { ja: "削除完了を確認", en: "Confirm cleanup is complete" },
      targetS: 6,
      ja: "Liteとlauncherのstack、それにDynamoDBとCodeBuildの残存がないことを確認して完了なのだ。",
      en: "Confirm that the Lite and launcher stacks are gone with no remaining DynamoDB tables or CodeBuild logs.",
      layout: "complete",
      theme: "cleanup",
      details: {
        ja: ["Lite stacks: deleted", "DynamoDB / logs: deleted", "launcher stack: deleted"],
        en: ["Lite stacks: deleted", "DynamoDB / logs: deleted", "Launcher stack: deleted"],
      },
      note: {
        ja: "AWSの請求を確認し、共有アカウントの既存リソースは削除しない",
        en: "Check AWS billing; do not remove unrelated resources from a shared account",
      },
    },
  ],
};
