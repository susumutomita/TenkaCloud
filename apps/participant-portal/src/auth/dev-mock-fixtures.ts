import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_LAUNCH_COMMAND,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
  ScoreEventsResponse,
} from "../api/portal-client";
import {
  AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
  LITE_DRILL_JOB_ID,
  LOCAL_DRILL_JOB_ID,
  WHAT_IS_DRILL_PROBLEM_ID,
} from "../dev-mock/flag-submit";
import { createCustomChallengeDrillFixture } from "./custom-challenge-drill-fixture";
import { createLiteCleanupDrillFixture } from "./lite-cleanup-drill-fixture";

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state に
 * なってしまう (= LP の「モックで試す」動線で competitor が操作できなくなる)。
 *
 * 本 module は dev-mock 起動時に各 page が seed する fixture を提供する。
 * production (= backend mode) では参照されない (= caller 側で `if (isBackend) return` ガード)。
 *
 * 出題構成 (Issue #2707 → #2711: LP ヒーローから始める自己解説型オンボーディング):
 *   1. 「TenkaCloud とは?」 — 動画の内容と実際の問題操作をつなぐ 6 ステップ。
 *      real cloud、Battle / Challenge、Local / Lite / SaaS を確認してから、
 *      問題文を読む → 起動する → 調査・修正する → flag を提出して得点する
 *   2. 「自分の TenkaCloud Lite を立てる」 — 実 AWS デプロイ (#2696、 lite-drill 契約)
 *   3. 「TenkaCloud Lite を片付ける」 — ACTION override と launcher 削除
 *   4. 「ローカルモードで遊ぶ」 — Docker / Codespaces。起動コマンドをそのまま提出
 *   5. 「AIエージェントでMac起動」 — LP のプロンプトからローカル起動確認までの実演
 *   6. 「独自問題を追加する」 — Problem Pack に 2 問目を足し、 解く側から作る側へ (#2781)
 *   (旧来の「クエスト」2 問は削除済み — チュートリアル 6 問で完結させ、 余計な問題で
 *    迷わせない。 完走後の導線はローカル / Lite の実在ドリルへ直接つなぐ)
 *
 * オンボーディングドリルは「本文は概要 → 詰まったら提出欄ごとのヒントでステップバイステップ手順」の
 * 同一構造。 ヒント content は fixture に同梱する (公開前提のオンボーディング教材であり、
 * 競技 flag の秘匿契約とは別物)。 開封状態は HintsPanel の dev-mock ローカル state。
 *
 * タイムスタンプはすべて **モジュール読み込み時刻からの相対値**。固定日時にすると実時刻が
 * 進んだとき「自動削除超過」「N 時間前に採点」の警告が出てデモが壊れて見えるため。
 */

const now = Date.now();
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
// 自動削除は常に「まだ先」に置く (= expired 警告を出さない)。
const DEPLOY_EXPIRES_AT = Math.floor((now + 4 * HOUR) / SEC);
const LITE_PIPELINE_TEMPLATE_URL =
  "https://github.com/susumutomita/TenkaCloud/blob/main/infrastructure/templates/lite-pipeline.yaml";
const LITE_CLOUDFORMATION_CREATE_STACK_URL =
  "https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-1#/stacks/create/template";

export const DEV_MOCK_TEAM_VIEW: ParticipantTeamView = {
  team: {
    teamId: "team-demo-1",
    teamName: "Demo Team",
    teamNameSetByCompetitor: true,
    eventId: "evt-demo",
  },
  problems: [
    {
      jobId: "01HZX0M0UNDR5TND7ENKA0CL0D",
      problemId: WHAT_IS_DRILL_PROBLEM_ID,
      // オンボーディング動画は、リポジトリを肥大化させないよう YouTube で配信する。
      videoUrl: "https://www.youtube.com/embed/mcL_O17QVsA",
      name: "はじめての TenkaCloud",
      // 動画で説明する製品の仕組みを省略せず、そのあとに標準の multi-flag UI で
      // 入力・ヒント公開・採点を体験する。独自クイズ UI は使わない。
      description: [
        "動画のあと、動画で説明したTenkaCloudの仕組みを3問で振り返り、問題文・ヒント・接続先・flag提出をTenkaCloudの実際の問題画面で体験する。",
        "",
        "#### この画面で確かめること",
        "",
        "1. TenkaCloudは紙の知識クイズではなく、実際に動く環境で調査や修正を練習する",
        "2. Battleは同時に得点を競い、Challengeは自分のペースで進める",
        "3. Local、Lite、SaaSの違いと、DockerがLocalで必要になる理由",
        "4. 困ったら「ヒントを公開する」を押し、確認画面からヒントを開く",
        "5. 問題がRunningになったら接続先を開き、環境を調べたり直したりする",
        "6. 見つけた`TC{...}`形式のflagを提出して得点する",
        "",
        "#### はじめて出てくる言葉",
        "",
        "- **クラウド**: インターネット越しに、サーバーや保存場所を必要な分だけ使う仕組み",
        "- **Docker**: アプリ、設定、必要なソフトをひとまとめにし、同じ練習環境を手元のパソコンでも再現しやすくする仕組み。Localを選ぶときに使う",
        "- **問題環境**: その問題専用に起動する、壊しても本番のサービスへ影響しない練習場所",
        "- **flag**: 問題を解けた証拠として提出する`TC{...}`形式の文字列",
        "",
        "下の6問はすべて、実際のTenkaCloudと同じflag入力・ヒント公開・採点の仕組みを使う。4問目ではヒントを実際に開いて答えを確認する。完了後は独立したローカルモード問題で本物の環境を試せる。",
      ].join("\n"),
      instructions:
        "動画を見たあと、6つの提出欄を順番に進める。わからないときは各欄の「ヒントを公開する」を押す。4問目では必ずヒントを開き、TenkaCloudのヒント公開操作を体験する。",
      i18n: {
        en: {
          name: "Your first TenkaCloud walkthrough",
          videoUrl: "https://www.youtube.com/embed/6qMzFcP5dgw",
          description: [
            "After the video, review three TenkaCloud concepts, then use the real problem UI to practise reading, revealing a hint, opening an endpoint, and submitting a flag.",
            "",
            "#### What this walkthrough checks",
            "",
            "1. TenkaCloud uses real running environments, not a paper knowledge quiz",
            "2. Battle is a simultaneous score competition; Challenge is self-paced",
            "3. The difference between Local, Lite, and SaaS, and why Local uses Docker",
            "4. How to select Reveal hint and confirm the reveal when you get stuck",
            "5. How to open the endpoint after the problem is Running and investigate or repair it",
            "6. How to submit the `TC{...}` flag you found and score",
            "",
            "#### Terms introduced here",
            "",
            "- **Cloud**: a way to use servers and storage over the internet as needed",
            "- **Docker**: packages an app, settings, and required software so Local mode can recreate the same practice environment on your computer",
            "- **Problem environment**: an isolated practice area created for one problem, safe to investigate or repair without affecting a production service",
            "- **Flag**: a `TC{...}` value submitted as proof that you solved the problem",
            "",
            "All six checks use the same flag input, hint reveal, and scoring mechanisms as a real TenkaCloud problem. Check 4 deliberately asks you to reveal a hint. Afterward, use the separate local-mode problem for a real environment.",
          ].join("\n"),
          instructions:
            "Watch the video, then complete all six flag rows in order. Use Reveal hint whenever you get stuck. On check 4, reveal the hint so you experience the real hint flow.",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 0,
      scoring: {
        kind: "multi-flag",
        flags: [
          {
            id: "tenka-what",
            label: "1. TenkaCloudが練習に使う場所は？",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Where does TenkaCloud run its practice environments?" } },
            hints: [
              {
                id: "whatis-h1",
                penalty: 0,
                revealed: false,
                content:
                  "動画では、紙のクイズではなく「本物のクラウド」を練習の舞台にすると説明している。答えは「本物のクラウド」。",
                i18n: {
                  en: {
                    content:
                      'The video says that TenkaCloud uses the real cloud, rather than a paper quiz. Submit "real cloud".',
                  },
                },
              },
            ],
          },
          {
            id: "battle-challenge",
            label: "2. 同時に得点を競う形式は？",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. Which format is a simultaneous score competition?" } },
            hints: [
              {
                id: "whatis-h2",
                penalty: 0,
                revealed: false,
                content:
                  "Battleは同時に得点を競う形式。Challengeは自分のペースで進める形式。答えは「Battle」。",
                i18n: {
                  en: {
                    content:
                      'Battle is the simultaneous score competition; Challenge is self-paced. Submit "Battle".',
                  },
                },
              },
            ],
          },
          {
            id: "choose-mode",
            label: "3. 手元のパソコンだけで試すモードは？",
            points: 100,
            solved: false,
            i18n: { en: { label: "3. Which mode runs only on your own computer?" } },
            hints: [
              {
                id: "whatis-h3",
                penalty: 0,
                revealed: false,
                content:
                  "LocalはDockerを使い、手元のパソコンで問題環境を動かす。Liteは自分のAWS、SaaSは運営側の環境を使う。答えは「Local」。",
                i18n: {
                  en: {
                    content:
                      'Local uses Docker to run the problem environment on your computer. Lite uses your AWS account; SaaS uses the hosted environment. Submit "Local".',
                  },
                },
              },
            ],
          },
          {
            id: "read-problem",
            label: "4. ヒントを開き、問題で最初に読むものを提出",
            points: 100,
            solved: false,
            i18n: {
              en: { label: "4. Reveal the hint and submit what you read first in a problem" },
            },
            hints: [
              {
                id: "whatis-h4",
                penalty: 0,
                revealed: false,
                content:
                  "ヒントを公開できた。問題では、起動や操作の前に状況・ゴール・完了条件が書かれた「問題文」を読む。答えは「問題文」。",
                i18n: {
                  en: {
                    content:
                      'You revealed the hint. Before starting or operating anything, read the problem statement for the situation, goal, and completion condition. Submit "problem statement".',
                  },
                },
              },
            ],
          },
          {
            id: "open-endpoint",
            label: "5. 問題がRunningになったあとに開くものは？",
            points: 100,
            solved: false,
            i18n: { en: { label: "5. What do you open after the problem becomes Running?" } },
            hints: [
              {
                id: "whatis-h5",
                penalty: 0,
                revealed: false,
                content:
                  "Runningになったら「接続先」を開き、用意された環境を調べたり直したりする。答えは「接続先」。",
                i18n: {
                  en: {
                    content:
                      'Once the problem is Running, open its endpoint and investigate or repair the environment. Submit "endpoint".',
                  },
                },
              },
            ],
          },
          {
            id: "first-flag",
            label: "6. 問題で見つけたflagを提出",
            points: 100,
            solved: false,
            i18n: { en: { label: "6. Submit the flag found in the problem" } },
            hints: [
              {
                id: "whatis-h6",
                penalty: 0,
                revealed: false,
                content:
                  "この体験版の合言葉は「TC{HELLO-TENKACLOUD}」。実際の問題では、練習環境を調べて見つけたTC{...}全体を提出する。",
                i18n: {
                  en: {
                    content:
                      'The passphrase in this walkthrough is "TC{HELLO-TENKACLOUD}". In a real problem, submit the full TC{...} value you found in the practice environment.',
                  },
                },
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: LITE_DRILL_JOB_ID,
      problemId: LITE_DRILL_PROBLEM_ID,
      // 実際の AWS 操作を使った短尺動画。 locale ごとに音声を分け、WebVTT 字幕を付ける。
      videoUrl: "https://www.youtube.com/embed/ItgRfIeQ0ac",
      name: "自分の TenkaCloud Lite を立てる",
      // 注: fixture 問題は catalog metadata を持たないため ProblemInfoSection (= instructions
      // の描画箇所) が skip される。 competitor に見せる本文はすべて description に置く
      // (ProblemPanel が <Markdown> で描画する唯一の確実な経路)。 instructions は将来
      // metadata 経路が通ったときのための短い要約に留める。
      description: [
        "チュートリアルの仕上げ。デモの外に出て、自分の AWS アカウントに **本物の TenkaCloud Lite** を立ち上げる。",
        "手順を正しく実行するたびに、実環境の画面にチェックポイントコード `TC{...}` が現れる。それを下の対応する提出欄に貼って得点しよう。",
        "`lite-pipeline.yaml` は、CloudFormationに読み込ませる**自動デプロイ環境のひな形**。名前にpipelineとあるが、AWS CodePipelineは使わない。CloudFormationがCodeBuildとIAM Roleを用意するので、`Start build` を押せば、細かいデプロイ手順を知らなくてもLiteを自動構築できる。",
        "",
        "#### AWSサービスの役割",
        "",
        "- **CloudFormation**: YAMLのひな形を読み、必要なAWSリソースをまとめて作る",
        "- **CodeBuild**: AWS上の一時的なコンピューターで、TenkaCloudの構築処理を自動実行する",
        "- **IAM Role**: CodeBuildがAWSリソースを作るために使う実行権限",
        "- **S3 / CloudFront**: Admin ConsoleとParticipant Portalの画面を保存・配信する",
        "- **Cognito**: 管理者と参加者のログインを扱う",
        "- **Lambda / API Gateway / DynamoDB**: APIの処理、公開、イベントやスコアなどのデータ保存を担う",
        "- **Step Functions / EventBridge**: デプロイなど複数段階の処理と、サービス間のイベント連携を進める",
        "- **CloudWatch / Systems Manager**: 実行ログの確認と、設定値の安全な保管に使う",
        "",
        "#### `Start build` のあとに起きること",
        "",
        "1. CodeBuildがTenkaCloudと問題カタログを取得する",
        "2. CodeBuildがビルドとCDKによるデプロイを自動実行する",
        "3. CloudFormationがTenkaCloud Lite本体のAWSリソースを作成する",
        "",
        "**AWS経験者向け:** CloudFormation stack → CodeBuild project → CDK deploy → CloudFormation stacks。CodeBuildのServiceRoleにはIAM Roleを使用する。",
        "",
        "#### はじめる前に",
        "",
        "- この動画では手順を明確にするため `AdministratorAccess` のユーザーで操作する。実運用ではデプロイに必要な権限へ絞る",
        "- 受信できるメールアドレスが必要",
        "- デプロイ中はデフォルト構成で **約 $7/月** の継続費用が発生する(遊び終えたら必ず片付ける)",
        "- 自動デプロイ環境はCodeBuild用に広い権限のIAM Roleを作成する(CloudFormationのIAM acknowledgeで明示同意する)",
        "",
        "#### 進め方",
        "",
        "チェックポイントは4つ: 自動デプロイ環境を作成 → Liteデプロイ完了 → Competitorアカウント検証 → 初回イベント作成。",
        "続けてイベントを Deploy し、Participant Portal に team login key で入り、問題をプレイしてスコア反映まで確認する。動画はこの一連の使い方に集中している。",
        "各ステップの詳しい手順は、提出欄ごとの **ヒント** を開くと表示される(ペナルティなし)。自力で進める人はネタバレなしで挑戦できる。",
        "",
        "4 ステップを終えて遊び終わったら、次の問題 **「TenkaCloud Lite を片付ける」** へ進む。課金を止めるところまでがオンボーディング。",
      ].join("\n"),
      instructions:
        "各ステップで実環境の画面に現れる `TC{...}` コードを、下の対応する提出欄に貼って得点する。手順の詳細は提出欄ごとのヒントから。",
      i18n: {
        en: {
          videoUrl: "https://www.youtube.com/embed/7LjkPdf5zM0",
          name: "Deploy your own TenkaCloud Lite",
          description: [
            "The tutorial finale. Step outside the demo and stand up a **real TenkaCloud Lite** in your own AWS account.",
            "Each step you complete reveals a `TC{...}` checkpoint code on the real screens — paste it into the matching submission box below to score.",
            "`lite-pipeline.yaml` is an **automatic deployment setup template** that you load into CloudFormation. Despite the filename, it does not use the AWS CodePipeline service. CloudFormation creates a CodeBuild project and IAM Role, so pressing `Start build` deploys Lite automatically without learning every underlying deployment step.",
            "",
            "#### What the AWS services do",
            "",
            "- **CloudFormation**: reads the YAML template and creates the required AWS resources together",
            "- **CodeBuild**: provides a temporary computer in AWS that runs the TenkaCloud deployment automatically",
            "- **IAM Role**: grants CodeBuild permission to create the AWS resources",
            "- **S3 / CloudFront**: stores and serves the Admin Console and Participant Portal",
            "- **Cognito**: handles administrator and participant login",
            "- **Lambda / API Gateway / DynamoDB**: runs and publishes APIs and stores event, score, and related data",
            "- **Step Functions / EventBridge**: coordinates multi-step work such as deployment and passes events between services",
            "- **CloudWatch / Systems Manager**: provides execution logs and secure configuration storage",
            "",
            "#### What happens after `Start build`",
            "",
            "1. CodeBuild downloads TenkaCloud and the problem catalog",
            "2. CodeBuild runs the build and CDK deployment automatically",
            "3. CloudFormation creates the AWS resources for the TenkaCloud Lite platform",
            "",
            "**AWS shorthand:** CloudFormation stack → CodeBuild project → CDK deploy → CloudFormation stacks. An IAM Role is attached as the CodeBuild ServiceRole.",
            "",
            "#### Before you start",
            "",
            "- The video uses an `AdministratorAccess` user for a clear walkthrough. In production, narrow it to the permissions required for deployment",
            "- You need an email address you can read",
            "- The default profile costs **about $7/month** while deployed (tear it down when you are done)",
            "- The automatic deployment setup creates a broad-permission IAM Role for CodeBuild internally (you acknowledge it in CloudFormation)",
            "",
            "#### How to play",
            "",
            "There are 4 checkpoints: create the automatic deployment setup → Lite deploy completes → verify a competitor account → create your first event.",
            "Then deploy the event, sign in through the Participant Portal with the team key, play the problem, and confirm the score. The video focuses on this end-to-end product workflow.",
            "Open the **hint** on each submission box for the detailed instructions (penalty-free). Prefer to figure it out yourself? Go in blind.",
            "",
            'After all 4 steps and when you are done playing, continue to the separate **"Clean up TenkaCloud Lite"** problem. Onboarding ends only after the charges are stopped.',
          ].join("\n"),
          instructions:
            "Each step reveals a `TC{...}` code on the real screens — paste it into the matching submission box below. Detailed steps live in each box's hint.",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      // 全 sub-flag 未提出で始める (= 実デプロイに進んだ学習者だけが埋められる)。
      score: 0,
      scoring: {
        kind: "multi-flag",
        flags: [
          {
            id: LITE_DRILL_CHECKPOINTS.launcherCreated.flagId,
            label: "1. デプロイ用パイプライン作成",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Deployment pipeline created" } },
            hints: [
              {
                id: "lite-h1",
                penalty: 0,
                revealed: false,
                content: [
                  `[TenkaCloud の lite-pipeline.yaml](${LITE_PIPELINE_TEMPLATE_URL}) をダウンロードする。`,
                  `[AWS CloudFormation の「スタックの作成」](${LITE_CLOUDFORMATION_CREATE_STACK_URL}) を開き、**テンプレートファイルのアップロード**で先ほどの YAML を選ぶ。`,
                  "スタック名は `tenkacloud-lite-launcher`。必須入力は `TenantAdminEmail` のみで、IAM acknowledge にチェックする。",
                  "`tenkacloud-lite-launcher` は自動デプロイ環境のCloudFormation stack名。CloudFormationがCodeBuildとIAM Roleを作り、そのCodeBuildが必要な処理を自動化するため、利用者が `git clone`・`make deploy`・CDKを手動で操作する必要はない。次のステップで `Start build` を押すと、`tenkacloud-lite` / `tenkacloud-lite-problem-deploy` の2スタックが作られる。",
                  "作成完了後、スタックの「出力 (Outputs)」タブにある `OnboardingDrillCheckpoint` の値を提出する。",
                ].join("\n\n"),
                i18n: {
                  en: {
                    content: [
                      `[Download TenkaCloud's lite-pipeline.yaml](${LITE_PIPELINE_TEMPLATE_URL}).`,
                      `[Open AWS CloudFormation Create stack](${LITE_CLOUDFORMATION_CREATE_STACK_URL}), choose **Upload a template file**, and select the YAML you downloaded.`,
                      "Use `tenkacloud-lite-launcher` as the stack name. The only required input is `TenantAdminEmail`; check the IAM acknowledgement.",
                      "`tenkacloud-lite-launcher` is the CloudFormation stack name for the automatic deployment setup. CloudFormation creates the CodeBuild project and IAM Role, and CodeBuild automates the required work, so you do not operate `git clone`, `make deploy`, or CDK manually. In the next step, press `Start build` to create the `tenkacloud-lite` and `tenkacloud-lite-problem-deploy` stacks.",
                      "After it completes, submit the `OnboardingDrillCheckpoint` value from the stack's Outputs tab.",
                    ].join("\n\n"),
                  },
                },
              },
            ],
          },
          {
            id: LITE_DRILL_CHECKPOINTS.deployComplete.flagId,
            label: "2. Lite デプロイ完了",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. Lite deploy complete" } },
            hints: [
              {
                id: "lite-h2",
                penalty: 0,
                revealed: false,
                content:
                  "Outputs の `StartBuildConsoleUrl` から CodeBuild プロジェクトを開き「ビルドを開始」。ビルドは数十分かかることがある。ログ末尾の `Lite mode deploy complete` ブロックに印字されるコードを提出する。",
                i18n: {
                  en: {
                    content:
                      "Open the CodeBuild project from the `StartBuildConsoleUrl` output and press Start build. The build can take tens of minutes; submit the code printed in the `Lite mode deploy complete` block at the end of the log.",
                  },
                },
              },
            ],
          },
          {
            id: LITE_DRILL_CHECKPOINTS.competitorVerified.flagId,
            label: "3. Competitor アカウント検証",
            points: 100,
            solved: false,
            i18n: { en: { label: "3. Competitor account verified" } },
            hints: [
              {
                id: "lite-h3",
                penalty: 0,
                revealed: false,
                content:
                  "招待メールの一時パスワードで Application Admin Console にサインインする。**Competitor Accounts** で競技用 AWS アカウントを登録し、表示される bootstrap テンプレートを競技側アカウントに適用してから「検証」を押す。成功表示に出るコードを提出する。",
                i18n: {
                  en: {
                    content:
                      "Sign in to the Application Admin Console with the temporary password from the invite email. In **Competitor Accounts**, register your competition AWS account, apply the bootstrap template it shows, then press Verify. Submit the code shown on success.",
                  },
                },
              },
            ],
          },
          {
            id: LITE_DRILL_CHECKPOINTS.firstEventCreated.flagId,
            label: "4. 初回イベント作成",
            points: 100,
            solved: false,
            i18n: { en: { label: "4. First event created" } },
            hints: [
              {
                id: "lite-h4",
                penalty: 0,
                revealed: false,
                content:
                  "**Events** タブからイベントを作成する(チームに検証済みアカウントを割り当てる)。作成成功画面に表示されるコードを提出する。",
                i18n: {
                  en: {
                    content:
                      "Create an event from the **Events** tab (assign the verified account to a team). Submit the code shown on the creation success screen.",
                  },
                },
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    createLiteCleanupDrillFixture({
      expiresAt: DEPLOY_EXPIRES_AT,
      createdAt: iso(-25 * MIN),
    }),
    {
      jobId: LOCAL_DRILL_JOB_ID,
      problemId: LOCAL_DRILL_PROBLEM_ID,
      name: "WordPress問題を自分のパソコンで試す",
      description: [
        "ここからは見本ではなく、実際のWordPressサイトを自分のパソコンで動かして調べる。公開中のサイトへ影響を出さず、TenkaCloudの問題を解く→提出する→採点される流れを体験できる。",
        "",
        "#### 最初に言葉を整理",
        "",
        "- **Docker**: WordPress本体・設定・必要なソフトをひとまとめにし、同じ練習環境を作り直せるようにする道具",
        "- **コンテナ**: Dockerが起動する、ほかから区切られた練習用の実行環境。この問題ではWordPressと採点処理が動く",
        "- **ターミナル**: マウス操作ではなく、短い命令文を入力してパソコンへ指示する画面",
        "- **ローカルモード**: クラウドへ公開せず、自分のパソコンの中だけで問題環境と採点を動かすTenkaCloudの遊び方",
        "",
        "#### 必要な環境",
        "",
        "- Docker Desktopなど、Dockerを動かせるアプリ(macOS / Linux / WindowsはWSL2)",
        "- または GitHub Codespaces — ブラウザだけで、手元には何もインストールせずに遊べる",
        "",
        "#### 起動方法",
        "",
        "1. `git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git`",
        "2. `make install`(ツールチェーンがおかしいときは `make doctor` で診断できる)",
        "3. `make local`",
        "4. ready 表示に `Participant Portal ... 5175` と出たら、ブラウザで Portal を開く",
        "5. ログイン画面が出たら、**チームキーは自動で入力済み**なので、そのまま「サインイン」を押すだけ(自分でキーを打つ必要はない。`make local` ごとに変わる使い捨てのチームキーが Portal に自動で渡される)",
        "6. 問題一覧から **「前任者の忘れ物」** (`wp-exposed-backup`) を選び、Startを押す",
        "7. 起動したWordPressサイトを開き、まず `/robots.txt` を確認する。公開フォルダに残されたバックアップや設定ファイルの控えを探す",
        "8. 見つけた `TC{...}` の合言葉を、対応する提出欄へ送る",
        "",
        "Codespaces で遊ぶ場合は https://codespaces.new/susumutomita/TenkaCloud から作成し、開いたターミナルで同じ `make local` を実行すればいい(ポートはブラウザへ自動で転送される)。",
        "",
        "#### クラウドで動かす場合との違い",
        "",
        "- **ローカルモード** — AWS 不要・追加費用ゼロ・Docker ベースの入門ドリルのみ・起動は数分",
        "- **Lite モード(実 AWS)** — 自分の AWS アカウントに TenkaCloud をデプロイし、本物のインフラで本格的なイベントを主催できる。デプロイ中はデフォルト構成で **約 $7/月** の継続費用が発生する",
        "",
        "#### チェックポイント",
        "",
        "1. 起動した Participant Portal のポート番号を答える",
        "2. ローカルモードを起動したコマンドを提出する",
        "",
        "手順に詰まったら各提出欄の **ヒント** を開こう(ペナルティなし)。クリアしたら、まだの人は「自分の TenkaCloud Lite を立てる」で仕上げよう。",
      ].join("\n"),
      instructions:
        "手元のマシンか GitHub Codespaces でローカルモードを起動し、2 つのチェックポイントを提出する。ヒントはペナルティなしで開ける。",
      i18n: {
        en: {
          name: "Try the WordPress problem on your computer",
          description: [
            "This is no longer sample data. Run a real WordPress site on your own computer, inspect it without affecting a public site, and use the real TenkaCloud solve → submit → score flow.",
            "",
            "#### Four terms first",
            "",
            "- **Docker**: a tool that packages WordPress, its settings, and required software so the same practice environment can be recreated",
            "- **Container**: an isolated practice environment started by Docker; this problem runs WordPress and its verifier in containers",
            "- **Terminal**: a window where you type short commands to tell your computer what to do",
            "- **Local mode**: the TenkaCloud mode that runs the problem and scoring only on your computer, without publishing it to the cloud",
            "",
            "#### Prerequisites",
            "",
            "- Docker Desktop or another way to run Docker (macOS / Linux / Windows via WSL2)",
            "- Or GitHub Codespaces — nothing to install locally, everything runs in the browser",
            "",
            "#### How to start",
            "",
            "1. `git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git`",
            "2. `make install` (use `make doctor` if the toolchain looks broken)",
            "3. `make local`",
            "4. When the ready output shows `Participant Portal ... 5175`, open the Portal in your browser",
            "5. On the login screen the **team key is already filled in** — just press **Sign in** (no need to type a key; local mode hands the Portal a throwaway team key that changes on every `make local`)",
            '6. Pick **"The Predecessor\'s Leftovers"** (`wp-exposed-backup`) from the problem list and press Start',
            "7. Open the WordPress site and check `/robots.txt` first. Look for backups or configuration copies left in a public folder",
            "8. Submit each `TC{...}` passphrase you find to its matching field",
            "",
            "On Codespaces, create one from https://codespaces.new/susumutomita/TenkaCloud and run the same `make local` in its terminal — the port forwards to your browser automatically.",
            "",
            "#### How this differs from running in the cloud",
            "",
            "- **Local mode** — no AWS, no extra cost, Docker-based intro drills only, ready in minutes",
            "- **Lite mode (real AWS)** — deploys TenkaCloud into your own AWS account to host a real event on real infrastructure; the default profile costs **about $7/month** while deployed",
            "",
            "#### Checkpoints",
            "",
            "1. Answer the Participant Portal port shown when local mode starts",
            "2. Submit the command you used to start local mode",
            "",
            'Stuck? Open the **hint** on each submission box (no penalty). Then finish with "Deploy your own TenkaCloud Lite" if you have not yet.',
          ].join("\n"),
          instructions:
            "Start local mode on your own machine or GitHub Codespaces, then submit the 2 checkpoints. Hints are penalty-free.",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 0,
      scoring: {
        kind: "multi-flag",
        flags: [
          {
            id: "portal-port",
            label: "1. 起動した Portal のポート番号は?",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Which port does the Portal start on?" } },
            hints: [
              {
                id: "local-h1",
                penalty: 0,
                revealed: false,
                content:
                  "Docker を起動する(GitHub Codespaces なら不要)。TenkaCloud リポジトリで `make local` を実行すると、ready 表示に `Participant Portal ... 5175` と出るので、その 4 桁を提出する。",
                i18n: {
                  en: {
                    content:
                      "Start Docker (skip this on GitHub Codespaces). Run `make local` from the TenkaCloud repository — the ready message shows `Participant Portal ... 5175`; submit those four digits.",
                  },
                },
              },
            ],
          },
          {
            id: LOCAL_DRILL_LAUNCH_COMMAND.flagId,
            label: "2. ローカルモードを起動したコマンド",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. The command you used to start local mode" } },
            hints: [
              {
                id: "local-h2",
                penalty: 0,
                revealed: false,
                content:
                  "ターミナル(手元のマシンでも Codespaces でもよい)で、TenkaCloud リポジトリからローカルモードを起動したコマンドをそのままここに貼る。",
                i18n: {
                  en: {
                    content:
                      "Paste the exact command you ran in the terminal (your own machine or Codespaces), from the TenkaCloud repository, to start local mode.",
                  },
                },
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: "01HZX0M2A1AGENTMACTENKA0003",
      problemId: AI_AGENT_LOCAL_DRILL_PROBLEM_ID,
      videoUrl: "https://www.youtube.com/embed/nLsSJ3npdfw",
      name: "AIエージェントでMac起動",
      description: [
        "LP の **AI エージェントで始める** にあるプロンプトを Claude Code や Codex へ貼ると、TenkaCloud の説明だけでなく、遊び始めるところまで案内してくれる。",
        "Mac で **PLAY → 手元のローカル環境** を選んだ今回の実演では、AI が前提確認、取得、インストール、ローカルモード起動、HTTP 疎通確認まで完走した。人が長いコマンド列を写すのではなく、AI が実環境を見ながら起動までこぎつけるのがポイントだ。",
        "",
        "#### チェックポイント",
        "",
        "1. AI が最初に読む正規ブリーフィングのファイル名を答える",
        "2. 起動完了時に HTTP 200 を確認した Participant Portal のポート番号を答える",
        "",
        "冒頭の 1 分動画で、プロンプトを貼ってからローカルモードが ready になるまでを確認できる。ヒントはペナルティなしで開ける。",
      ].join("\n"),
      instructions:
        "冒頭の 1 分動画を見て、AI が読んだブリーフィング名と、Mac 上で確認した Portal のポート番号を提出する。",
      i18n: {
        en: {
          name: "Launch on Mac with an AI agent",
          videoUrl: "https://www.youtube.com/embed/GDu9FhWrQns",
          description: [
            "Paste the prompt from **Start with an AI agent** on the landing page into Claude Code or Codex. The agent does more than explain TenkaCloud: it guides you all the way to a playable environment.",
            "In this Mac run, choosing **PLAY → local machine** let the agent check prerequisites, clone, install, start local mode, and verify HTTP reachability. The point is not memorizing a command list — it is seeing an agent inspect the real machine and carry the setup to ready.",
            "",
            "#### Checkpoints",
            "",
            "1. Submit the filename of the canonical briefing the agent reads first",
            "2. Submit the Participant Portal port that returned HTTP 200",
            "",
            "The one-minute video shows the path from pasted prompt to a ready local mode. Hints are penalty-free.",
          ].join("\n"),
          instructions:
            "Watch the one-minute video, then submit the briefing filename and the Portal port verified on the Mac.",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 0,
      scoring: {
        kind: "multi-flag",
        flags: [
          {
            id: "briefing-file",
            label: "1. AI が最初に読むブリーフィングは?",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Which briefing does the agent read first?" } },
            hints: [
              {
                id: "ai-mac-h1",
                penalty: 0,
                revealed: false,
                content:
                  "LP のプロンプトは `Fetch https://tenkacloud.com/...` で始まる。URL 末尾のファイル名を、拡張子まで含めて提出する。",
                i18n: {
                  en: {
                    content:
                      "The landing-page prompt starts with `Fetch https://tenkacloud.com/...`. Submit the filename at the end of that URL, including its extension.",
                  },
                },
              },
            ],
          },
          {
            id: "portal-port",
            label: "2. HTTP 200 を確認した Portal のポート番号は?",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. Which Portal port returned HTTP 200?" } },
            hints: [
              {
                id: "ai-mac-h2",
                penalty: 0,
                revealed: false,
                content:
                  "動画の終盤に `Participant Portal ... LISTENING` と `HTTP 200` が表示される。同じ行にある 4 桁のポート番号を提出する。",
                i18n: {
                  en: {
                    content:
                      "Near the end of the video, `Participant Portal ... LISTENING` and `HTTP 200` appear. Submit the four-digit port shown on that line.",
                  },
                },
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    createCustomChallengeDrillFixture({
      expiresAt: DEPLOY_EXPIRES_AT,
      createdAt: iso(-25 * MIN),
    }),
  ],
  eventGate: { kind: "ok" },
};

export const DEV_MOCK_LEADERBOARD: LeaderboardResponse = {
  eventId: "evt-demo",
  entries: [
    {
      rank: 1,
      teamId: "team-alpha",
      teamName: "Alpha Squad",
      score: 600,
      completedProblems: 2,
      totalProblems: DEV_MOCK_TEAM_VIEW.problems.length,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 450,
      completedProblems: 1,
      totalProblems: DEV_MOCK_TEAM_VIEW.problems.length,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 300,
      completedProblems: 1,
      totalProblems: DEV_MOCK_TEAM_VIEW.problems.length,
      isMyTeam: false,
    },
    // 自チームは 0 pt から始める (= チュートリアルを解くと leaderboard が動く体験)。
    {
      rank: 4,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 0,
      completedProblems: 0,
      totalProblems: DEV_MOCK_TEAM_VIEW.problems.length,
      isMyTeam: true,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 0,
      completedProblems: 0,
      totalProblems: DEV_MOCK_TEAM_VIEW.problems.length,
      isMyTeam: false,
    },
  ],
  scoreboardFrozen: false,
  endsAt: iso(4 * HOUR),
};

export const DEV_MOCK_NOTIFICATIONS: NotificationsResponse = {
  eventId: "evt-demo",
  items: [
    {
      notificationId: "notif-003",
      title: "オンボーディングチュートリアルを開放",
      body: "「TenkaCloud とは?」から始めて「自分の TenkaCloud Lite を立てる」へ進み、「TenkaCloud Lite を片付ける」で課金停止まで完走できます。AWS なしで遊ぶなら「ローカルモードで遊ぶ」、AI に任せるなら「AIエージェントでMac起動」も。仕上げは「独自問題を追加する」で、解く側から作る側へ。詰まったら各提出欄のヒント(ペナルティなし)へ。",
      severity: "info",
      occurredAt: iso(-2 * MIN),
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud のデモを開始しました。6 問のオンボーディングチュートリアルが出題されています。解いて flag を提出しよう!",
      severity: "info",
      occurredAt: iso(-25 * MIN),
    },
  ],
};

/**
 * 自チームの score 変動履歴。 ScoreEventsPage が直接 fetch する API の dev-mock 版。
 * 旧クエスト削除後は解答済み問題が無いため空 (= 0 pt スタートと整合)。 ページ側の
 * empty state がそのまま出る。
 */
export const DEV_MOCK_SCORE_EVENTS: ScoreEventsResponse = {
  entries: [],
};
