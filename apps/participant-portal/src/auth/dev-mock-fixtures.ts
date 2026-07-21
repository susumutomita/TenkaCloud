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

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state に
 * なってしまう (= LP の「モックで試す」動線で competitor が操作できなくなる)。
 *
 * 本 module は dev-mock 起動時に各 page が seed する fixture を提供する。
 * production (= backend mode) では参照されない (= caller 側で `if (isBackend) return` ガード)。
 *
 * 出題構成 (Issue #2707 → #2711: LP ヒーローから始める自己解説型オンボーディング):
 *   1. 「TenkaCloud とは?」 — 4 ステップのチュートリアル (#2711 デザイン 6b)。 モードの
 *      3 択 (ローカル / Lite / SaaS) はステップ 3 で初めて提示する
 *   2. 「自分の TenkaCloud Lite を立てる」 — 実 AWS デプロイ (#2696、 lite-drill 契約)
 *   3. 「ローカルモードで遊ぶ」 — 手元の Mac。 起動コマンド (`make local` 等) をそのまま提出
 *   4. 「AIエージェントでMac起動」 — LP のプロンプトからローカル起動確認までの実演
 *   (旧来の「クエスト」2 問は削除済み — チュートリアル 4 本で完結させ、 余計な問題で
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
      name: "TenkaCloud とは?",
      // #2711 (デザイン 6b): 4 ステップのチュートリアル。 モードの 3 択 (ローカル /
      // Lite / SaaS) は LP には出さず、 ここのステップ 3 で初めて提示する。
      description: [
        "ようこそ。これは説明ページではなく、**解ける問題**だ。4 つのステップに答えながら、TenkaCloud が何かを掴む。",
        "",
        "#### ステップ 1 · TenkaCloud とは",
        "",
        "TenkaCloud は、**本物のクラウド**のアカウント上で競技するクラウド競技プラットフォーム。「ローカルでは動く」アプリを、認証・公開範囲・監査・可用性まで本番品質へ鍛える。ステップ 1 は「何の上で競技する?」に本文の太字で答える。",
        "",
        "#### ステップ 2 · Battle と Challenge",
        "",
        "問題は 2 カテゴリ。**Battle** はリアルタイムの対戦形式、**Challenge** は自分のペースで解ける常設形式。ステップ 2 は「リアルタイム対戦のカテゴリは?」。",
        "",
        "#### ステップ 3 · モードを選ぶ",
        "",
        "TenkaCloud は同じ問題をどの環境でも動かせる。まず選ぶモードは 3 つ(いま見ているこのタブは、登録不要でモックデータが動く**ブラウザデモ**)。次に試したいモードを提出欄に書く(**どれも正解**)。",
        "",
        "- **ローカルモード**(AWS 不要)— Docker が動く PC や GitHub Codespaces で、本物の問題コンテナを手元で動かす。まず遊ぶならこれ",
        "- **Lite モード**(実 AWS)— 自分の AWS アカウントに TenkaCloud 本体をデプロイして、自分のイベントを主催する。データストアは DynamoDB / Turso を選べる",
        "- **SaaS モード**(上級者向け)— TenkaCloud をマルチテナント SaaS として展開する運営者モード。構成も運用も本格的",
        "",
        "ほかに、イベント開催中だけ AWS を立ち上げて待機コストをゼロにする運営者向けの **Always-On モード** もある。クリア後の問題一覧には、ローカルモードと Lite モードを実際に体験するドリルが並んでいる。",
        "",
        "#### ステップ 4 · flag を提出してみる",
        "",
        "TenkaCloud の採点は flag 提出が基本形。練習用の flag はこれ: `TENKA{HELLO-TENKACLOUD}`。そのままステップ 4 の提出欄に貼ると +100 pt — 採点とスコアの動きも、ここで最初に体験する。",
        "",
        "詰まったら各提出欄の **ヒント** を開こう(ペナルティなし)。全問正解すると解説と、次のドリル(「ローカルモードで遊ぶ」/「自分の TenkaCloud Lite を立てる」)へ進むボタンが現れる。",
      ].join("\n"),
      instructions:
        "4 つのステップに順に答える(大文字小文字は不問)。モードの 3 択はステップ 3 で初めて出てくる。ヒントはペナルティなしで開ける。",
      i18n: {
        en: {
          name: "What is TenkaCloud?",
          videoUrl: "https://www.youtube.com/embed/6qMzFcP5dgw",
          description: [
            "Welcome. This is not a pitch page — it is a **solvable problem**. Answer 4 steps and you will know what TenkaCloud is.",
            "",
            "#### Step 1 · What is TenkaCloud",
            "",
            'TenkaCloud is a cloud-competition platform where you compete on **the real cloud** — hardening "works locally" apps into production grade across auth, exposure, audit, and availability. Step 1 asks: what do you compete on? Answer with the bold words.',
            "",
            "#### Step 2 · Battle and Challenge",
            "",
            "Problems come in 2 categories: **Battle** is real-time head-to-head, **Challenge** is self-paced and evergreen. Step 2 asks for the real-time one.",
            "",
            "#### Step 3 · Choose your mode",
            "",
            "TenkaCloud runs the same problems anywhere. There are 3 modes to pick from first (this tab is the signup-free **browser demo** running on mock data). Submit the mode you want to try next (**any answer is correct**):",
            "",
            "- **Local mode** (no AWS) — run real problem containers on a Docker-capable machine or GitHub Codespaces. Start here to play",
            "- **Lite mode** (real AWS) — deploy TenkaCloud into your own AWS account and host your own event; pick DynamoDB or Turso as the data store",
            "- **SaaS mode** (advanced) — run TenkaCloud as a full multi-tenant SaaS; a serious setup with real operational work",
            "",
            "There is also an operator-focused **Always-On mode** that spins AWS up only while an event is running (zero idle compute between events). After you clear this, the problem list has drills that walk you through local mode and Lite mode for real.",
            "",
            "#### Step 4 · Submit your first flag",
            "",
            "Scoring in TenkaCloud is flag-based. Here is a practice flag: `TENKA{HELLO-TENKACLOUD}`. Paste it into the step 4 box for +100 pt — your first taste of scoring and the moving scoreboard.",
            "",
            "Stuck? Open the **hint** on each submission box (no penalty). Answer all four to reveal the explanation and buttons to the next drills — “Play local mode” and “Deploy your own TenkaCloud Lite.”",
          ].join("\n"),
          instructions:
            "Answer the 4 steps in order (case-insensitive). The mode choice only appears at step 3. Hints are penalty-free.",
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
            label: "1. TenkaCloud は何の上で競技する?",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. What does TenkaCloud compete on?" } },
            hints: [
              {
                id: "whatis-h1",
                penalty: 0,
                revealed: false,
                content:
                  "ステップ 1 の太字。「本物のクラウド」(または英語で real cloud)と提出する。",
                i18n: {
                  en: {
                    content:
                      'The bold words in step 1. Submit 本物のクラウド or, in English, "real cloud".',
                  },
                },
              },
            ],
          },
          {
            id: "battle-challenge",
            label: "2. リアルタイム対戦のカテゴリは?",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. Which category is real-time head-to-head?" } },
            hints: [
              {
                id: "whatis-h2",
                penalty: 0,
                revealed: false,
                content:
                  "ステップ 2 に太字のカテゴリが 2 つある。リアルタイムの方を英単語 1 語で提出する。",
                i18n: {
                  en: {
                    content:
                      "Step 2 has two bold categories; submit the real-time one as a single English word.",
                  },
                },
              },
            ],
          },
          {
            id: "choose-mode",
            label: "3. どこで動かす? — 選んだモードを提出",
            points: 100,
            solved: false,
            i18n: { en: { label: "3. Where will you run it? Submit your choice" } },
            hints: [
              {
                id: "whatis-h3",
                penalty: 0,
                revealed: false,
                content:
                  "どれを選んでも正解。**ローカルモード**は AWS 不要 — Docker が動く PC や GitHub Codespaces で本物の問題コンテナを動かす。**Lite モード**は自分の AWS アカウントに TenkaCloud をデプロイして自分のイベントを主催する(データストアは DynamoDB / Turso を選択可)。**SaaS モード**はマルチテナント SaaS として展開する上級者向け。「local」「lite」「saas」のどれかを提出する。",
                i18n: {
                  en: {
                    content:
                      'Any choice is correct. **Local mode** needs no AWS — real problem containers run on a Docker-capable machine or GitHub Codespaces. **Lite mode** deploys TenkaCloud into your own AWS account so you can host your own event (DynamoDB or Turso as the data store). **SaaS mode** runs TenkaCloud as a full multi-tenant SaaS — advanced, with real operational work. Submit "local", "lite", or "saas".',
                  },
                },
              },
            ],
          },
          {
            id: "first-flag",
            label: "4. 練習用 flag をそのまま提出",
            points: 100,
            solved: false,
            i18n: { en: { label: "4. Paste the practice flag as-is" } },
            hints: [
              {
                id: "whatis-h4",
                penalty: 0,
                revealed: false,
                content:
                  "ステップ 4 に印字されている `TENKA{HELLO-TENKACLOUD}` をコピーして、この欄に貼るだけ。大文字小文字と前後の空白は気にしなくていい。",
                i18n: {
                  en: {
                    content:
                      "Copy the `TENKA{HELLO-TENKACLOUD}` printed at step 4 and paste it here. Case and surrounding spaces do not matter.",
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
      // #2707 P0-1: 冒頭 1 分 operation 動画 (字幕 ja/en 焼き込み、landing origin 配信)。
      videoUrl: "/videos/onboarding/deploy-tenkacloud-lite.mp4",
      name: "自分の TenkaCloud Lite を立てる",
      // 注: fixture 問題は catalog metadata を持たないため ProblemInfoSection (= instructions
      // の描画箇所) が skip される。 competitor に見せる本文はすべて description に置く
      // (ProblemPanel が <Markdown> で描画する唯一の確実な経路)。 instructions は将来
      // metadata 経路が通ったときのための短い要約に留める。
      description: [
        "チュートリアルの仕上げ。デモの外に出て、自分の AWS アカウントに **本物の TenkaCloud Lite** を立ち上げる。",
        "手順を正しく実行するたびに、実環境の画面にチェックポイントコード `TENKA{...}` が現れる。それを下の対応する提出欄に貼って得点しよう。",
        "",
        "#### はじめる前に",
        "",
        "- 管理者相当の権限で使える AWS アカウントと、受信できるメールアドレスが必要",
        "- デプロイ中はデフォルト構成で **約 $7/月** の継続費用が発生する(遊び終えたら必ず片付ける)",
        "- launcher は CodeBuild 用に広い権限の IAM Role を作成する(CloudFormation の IAM acknowledge で明示同意する)",
        "",
        "#### 進め方",
        "",
        "ステップは 4 つ: Launcher スタック作成 → Lite デプロイ完了 → Competitor アカウント検証 → 初回イベント作成。",
        "各ステップの詳しい手順は、提出欄ごとの **ヒント** を開くと表示される(ペナルティなし)。自力で進める人はネタバレなしで挑戦できる。",
        "",
        "**片付け(採点対象外)** — 遊び終えたら CodeBuild の **Start build with overrides** で `ACTION=destroy` を実行し、最後に launcher スタック自体を削除して課金を止める。ここまでやって、オンボーディング完走!",
      ].join("\n"),
      instructions:
        "各ステップで実環境の画面に現れる `TENKA{...}` コードを、下の対応する提出欄に貼って得点する。手順の詳細は提出欄ごとのヒントから。",
      i18n: {
        en: {
          name: "Deploy your own TenkaCloud Lite",
          description: [
            "The tutorial finale. Step outside the demo and stand up a **real TenkaCloud Lite** in your own AWS account.",
            "Each step you complete reveals a `TENKA{...}` checkpoint code on the real screens — paste it into the matching submission box below to score.",
            "",
            "#### Before you start",
            "",
            "- You need an AWS account with admin-level access and an email address you can read",
            "- The default profile costs **about $7/month** while deployed (tear it down when you are done)",
            "- The launcher creates a broad-permission IAM Role for CodeBuild (you acknowledge it in CloudFormation)",
            "",
            "#### How to play",
            "",
            "There are 4 steps: create the launcher stack → Lite deploy completes → verify a competitor account → create your first event.",
            "Open the **hint** on each submission box for the detailed instructions (penalty-free). Prefer to figure it out yourself? Go in blind.",
            "",
            "**Clean up (not scored)** — When you are done, run **Start build with overrides** with `ACTION=destroy`, then delete the launcher stack itself to stop the charges. That completes the onboarding!",
          ].join("\n"),
          instructions:
            "Each step reveals a `TENKA{...}` code on the real screens — paste it into the matching submission box below. Detailed steps live in each box's hint.",
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
            label: "1. Launcher スタック作成",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Launcher stack created" } },
            hints: [
              {
                id: "lite-h1",
                penalty: 0,
                revealed: false,
                content:
                  "README の Quickstart から `lite-pipeline.yaml` で CloudFormation スタックを作成する(必須入力は `TenantAdminEmail` のみ、IAM acknowledge にチェック)。作成完了後、スタックの「出力 (Outputs)」タブにある `OnboardingDrillCheckpoint` の値を提出する。",
                i18n: {
                  en: {
                    content:
                      "Create the CloudFormation stack from lite-pipeline.yaml in the README Quickstart (the only required input is `TenantAdminEmail`; check the IAM acknowledgement). After it completes, submit the `OnboardingDrillCheckpoint` value from the stack's Outputs tab.",
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
    {
      jobId: LOCAL_DRILL_JOB_ID,
      problemId: LOCAL_DRILL_PROBLEM_ID,
      name: "ローカルモードで遊ぶ",
      description: [
        "AWS アカウントなしで、**本物の問題コンテナ**を Docker で手元に動かすのがローカルモード。ブラウザの Participant Portal から挑戦する、クラウド版と同じ解く→採点のループがそのまま体験できる。",
        "",
        "#### ローカルモードとは",
        "",
        "問題が Docker コンテナとして手元で起動し、ローカル採点 API と Participant Portal が解く→採点のループを担う。AWS には一切触れず、クラウド費用はゼロ。対象は Docker ベースの入門ドリルに限られるが、起動は数分で終わる。",
        "",
        "#### 必要な環境",
        "",
        "- Docker が動くマシン(macOS / Linux / Windows は WSL2)",
        "- または GitHub Codespaces — ブラウザだけで、手元には何もインストールせずに遊べる",
        "",
        "#### 起動方法",
        "",
        "1. `git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git`",
        "2. `make install`(ツールチェーンがおかしいときは `make doctor` で診断できる)",
        "3. `make local`",
        "4. ready 表示に `Participant Portal ... 5175` と出たら、ブラウザで Portal を開く",
        "5. 問題一覧から入門ドリル **sqli-demo** を選び、Start を押す",
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
          name: "Play local mode",
          description: [
            "Local mode runs **real problem containers** with Docker on your own machine, no AWS account needed. You play from the Participant Portal in your browser — the same solve-and-score loop as production.",
            "",
            "#### What local mode is",
            "",
            "Problems run as Docker containers on your machine, with a local scoring API and the Participant Portal handling the solve-and-score loop. AWS is never touched and cloud cost is zero. It only covers Docker-based intro drills, but it is ready in minutes.",
            "",
            "#### Prerequisites",
            "",
            "- A Docker-capable machine (macOS / Linux / Windows via WSL2)",
            "- Or GitHub Codespaces — nothing to install locally, everything runs in the browser",
            "",
            "#### How to start",
            "",
            "1. `git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git`",
            "2. `make install` (use `make doctor` if the toolchain looks broken)",
            "3. `make local`",
            "4. When the ready output shows `Participant Portal ... 5175`, open the Portal in your browser",
            "5. Pick the intro drill **sqli-demo** from the problem list and press Start",
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
      totalProblems: 4,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 450,
      completedProblems: 1,
      totalProblems: 4,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 300,
      completedProblems: 1,
      totalProblems: 4,
      isMyTeam: false,
    },
    // 自チームは 0 pt から始める (= チュートリアルを解くと leaderboard が動く体験)。
    {
      rank: 4,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 0,
      completedProblems: 0,
      totalProblems: 4,
      isMyTeam: true,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 0,
      completedProblems: 0,
      totalProblems: 4,
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
      body: "「TenkaCloud とは?」から始めて「自分の TenkaCloud Lite を立てる」へ進むと、理解から実デプロイまで得点しながら完走できます。AWS なしで遊ぶなら「ローカルモードで遊ぶ」、AI に任せるなら「AIエージェントでMac起動」も。詰まったら各提出欄のヒント(ペナルティなし)へ。",
      severity: "info",
      occurredAt: iso(-2 * MIN),
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud のデモを開始しました。4 問のオンボーディングチュートリアルが出題されています。解いて flag を提出しよう!",
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
