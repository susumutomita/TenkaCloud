import {
  LITE_DRILL_CHECKPOINTS,
  LITE_DRILL_PROBLEM_ID,
  LOCAL_DRILL_FIRST_SCORE,
  LOCAL_DRILL_PROBLEM_ID,
} from "@tenkacloud/portal-contracts";
import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
  ScoreEventsResponse,
} from "../api/portal-client";
import { UNDERSTAND_DRILL_PROBLEM_ID } from "../dev-mock/flag-submit";

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state に
 * なってしまう (= LP の「モックで試す」動線で competitor が操作できなくなる)。
 *
 * 本 module は dev-mock 起動時に各 page が seed する fixture を提供する。
 * production (= backend mode) では参照されない (= caller 側で `if (isBackend) return` ガード)。
 *
 * 出題構成 (Issue #2707: LP ヒーローから始める自己解説型オンボーディング):
 *   1. 「TenkaCloud を理解する」 — その場で解けるクイズ。 製品の構造を答えて得点する
 *   2. 「ローカルモードで遊ぶ」 — Codespaces で hello-world 初得点 → チェックポイント提出
 *   3. 「自分の TenkaCloud Lite を立てる」 — 実 AWS デプロイ (#2696、 lite-drill 契約)
 *   + 旧来の「クエスト」2 問 (hidden-passphrase は解答済み、 number-sequence は未解答)
 *
 * 3 部作は「本文は概要 → 詰まったら提出欄ごとのヒントでステップバイステップ手順」の
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

const CIPHER_PROBLEM_ID = "hidden-passphrase";
const SEQUENCE_PROBLEM_ID = "number-sequence";

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
      problemId: UNDERSTAND_DRILL_PROBLEM_ID,
      name: "TenkaCloud を理解する",
      description: [
        "ようこそ。TenkaCloud は、**本物のクラウドアカウント**の上で戦うクラウド競技プラットフォームだ。",
        "この最初の問題では、下の文章を読んで 4 つの問いに答え、製品の構造を掴む。答えはすべてこの文章の中にある。",
        "",
        "#### TenkaCloud の構造",
        "",
        "- 問題は 2 カテゴリで出題される。**Battle** はリアルタイムの対戦形式、**Challenge** は自分のペースで解ける常設形式",
        "- 競技者は **Participant Portal**(いままさに見ているこの画面)で問題・スコア・エンドポイントを見る",
        "- 主催者は Application Admin Console でイベント・チーム・問題配布を管理する",
        "- 1 つの AWS アカウントに最小構成で立てられる主催モードが **Lite** — このデモの 3 問目で実際に立てる",
        "",
        "詰まったら各提出欄の **ヒント** を開こう(ペナルティなし)。全問クリアしたら、次は「ローカルモードで遊ぶ」へ。",
      ].join("\n"),
      instructions:
        "下の 4 つの問いに、問題文中の太字の語で答える(大文字小文字は不問)。ヒントはペナルティなしで開ける。",
      i18n: {
        en: {
          name: "Understand TenkaCloud",
          description: [
            "Welcome. TenkaCloud is a cloud-competition platform where you compete on **real cloud accounts**.",
            "In this first problem you read the text below and answer 4 questions to grasp the product's structure. Every answer is in the text.",
            "",
            "#### How TenkaCloud is structured",
            "",
            "- Problems come in 2 categories: **Battle** is real-time head-to-head, **Challenge** is self-paced and evergreen",
            "- Competitors use the **Participant Portal** (the very screen you are looking at) to see problems, scores, and endpoints",
            "- Organizers manage events, teams, and problem delivery in the Application Admin Console",
            "- **Lite** is the hosting mode that stands everything up in a single AWS account — you will deploy it for real in problem 3",
            "",
            'Stuck? Open the **hint** on each submission box (no penalty). Clear all 4, then move on to "Play local mode".',
          ].join("\n"),
          instructions:
            "Answer the 4 questions below with the bold words from the text (case-insensitive). Hints are penalty-free.",
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
            id: "category-realtime",
            label: "Q1. リアルタイム対戦のカテゴリ名は?",
            points: 50,
            solved: false,
            i18n: { en: { label: "Q1. Which category is real-time head-to-head?" } },
            hints: [
              {
                id: "understand-h1",
                penalty: 0,
                revealed: false,
                content:
                  "「TenkaCloud の構造」の 1 行目に太字のカテゴリが 2 つある。リアルタイムの方を英単語 1 語で提出する。",
              },
            ],
          },
          {
            id: "category-selfpaced",
            label: "Q2. 自分のペースで解ける常設カテゴリは?",
            points: 50,
            solved: false,
            i18n: { en: { label: "Q2. Which category is self-paced and evergreen?" } },
            hints: [
              {
                id: "understand-h2",
                penalty: 0,
                revealed: false,
                content: "Q1 と同じ行のもう一方。英単語 1 語で提出する。",
              },
            ],
          },
          {
            id: "competitor-screen",
            label: "Q3. 競技者が問題とスコアを見る画面は?",
            points: 50,
            solved: false,
            i18n: { en: { label: "Q3. Which screen do competitors use for problems and scores?" } },
            hints: [
              {
                id: "understand-h3",
                penalty: 0,
                revealed: false,
                content:
                  "いままさに見ているこの画面の名前。「Participant Portal」または「portal」で提出する。",
              },
            ],
          },
          {
            id: "single-account-mode",
            label: "Q4. 1 つの AWS アカウントに最小構成で立てるモードは?",
            points: 50,
            solved: false,
            i18n: {
              en: { label: "Q4. Which hosting mode fits everything in one AWS account?" },
            },
            hints: [
              {
                id: "understand-h4",
                penalty: 0,
                revealed: false,
                content: "構造の最後の行の太字。このデモの 3 問目で実際に立てるモード。",
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: "01HZX0M1L0CALPLAYTENKA0002",
      problemId: LOCAL_DRILL_PROBLEM_ID,
      name: "ローカルモードで遊ぶ",
      description: [
        "AWS アカウントなしで、**本物の問題コンテナ**を手元で動かすのがローカルモード。ブラウザだけで済ませるなら **GitHub Codespaces** が最短ルートだ。",
        "Codespace を作ると Participant Portal が自動で開き、固定の入門ドリル **hello-world** が最初に表示される。",
        "",
        "#### チェックポイント",
        "",
        "1. Codespaces で Portal が自動で開くポート番号を答える",
        "2. hello-world を初クリアすると解説 (writeup) の末尾に現れる `TENKA{...}` コードを提出する",
        "",
        "手順に詰まったら各提出欄の **ヒント** を開こう(ペナルティなし)。クリアしたら、仕上げは「自分の TenkaCloud Lite を立てる」へ。",
      ].join("\n"),
      instructions:
        "Codespaces (または手元の `make local`) でローカルプレイを起動し、2 つのチェックポイントを提出する。ヒントはペナルティなしで開ける。",
      i18n: {
        en: {
          name: "Play local mode",
          description: [
            "Local mode runs **real problem containers** on your machine with no AWS account. The fastest browser-only route is **GitHub Codespaces**.",
            "Create a Codespace and the Participant Portal opens automatically, with the fixed intro drill **hello-world** shown first.",
            "",
            "#### Checkpoints",
            "",
            "1. Answer the port number the Portal auto-opens on in Codespaces",
            "2. Clear hello-world once and submit the `TENKA{...}` code that appears at the end of its writeup",
            "",
            'Stuck? Open the **hint** on each submission box (no penalty). Then finish the trilogy with "Deploy your own TenkaCloud Lite".',
          ].join("\n"),
          instructions:
            "Start local play in Codespaces (or `make local` on your machine) and submit the 2 checkpoints. Hints are penalty-free.",
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
            label: "1. Portal が自動で開くポート番号は?",
            points: 100,
            solved: false,
            i18n: { en: { label: "1. Which port does the Portal auto-open on?" } },
            hints: [
              {
                id: "local-h1",
                penalty: 0,
                revealed: false,
                content:
                  "GitHub の TenkaCloud リポジトリで「Code ▸ Codespaces ▸ Create codespace」を押す。数分待つと Portal のプレビューが自動で開く。VS Code の Ports タブ(または README の Quickstart)に Participant Portal のポート番号が数字 4 桁で載っている。",
              },
            ],
          },
          {
            id: LOCAL_DRILL_FIRST_SCORE.flagId,
            label: "2. hello-world 初クリアのコード",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. The code from your first hello-world clear" } },
            hints: [
              {
                id: "local-h2",
                penalty: 0,
                revealed: false,
                content:
                  "自動で開いた Portal で hello-world を開き、Start を押してコンテナを起動する。問題の指示どおりに flag を見つけて提出すると、クリア直後に解説 (writeup) が開く。その末尾の「オンボーディングドリル チェックポイント」にある `TENKA{...}` をここに貼る。",
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: "01HZX0KZZ3DR0PW9M4Q7XV2C5D",
      problemId: LITE_DRILL_PROBLEM_ID,
      name: "自分の TenkaCloud Lite を立てる",
      // 注: fixture 問題は catalog metadata を持たないため ProblemInfoSection (= instructions
      // の描画箇所) が skip される。 competitor に見せる本文はすべて description に置く
      // (ProblemPanel が <Markdown> で描画する唯一の確実な経路)。 instructions は将来
      // metadata 経路が通ったときのための短い要約に留める。
      description: [
        "3 部作の仕上げ。デモの外に出て、自分の AWS アカウントに **本物の TenkaCloud Lite** を立ち上げる。",
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
        "**片付け(採点対象外)** — 遊び終えたら CodeBuild の **Start build with overrides** で `ACTION=destroy` を実行し、最後に launcher スタック自体を削除して課金を止める。ここまでやって 3 部作完走!",
      ].join("\n"),
      instructions:
        "各ステップで実環境の画面に現れる `TENKA{...}` コードを、下の対応する提出欄に貼って得点する。手順の詳細は提出欄ごとのヒントから。",
      i18n: {
        en: {
          name: "Deploy your own TenkaCloud Lite",
          description: [
            "The trilogy finale. Step outside the demo and stand up a **real TenkaCloud Lite** in your own AWS account.",
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
            "**Clean up (not scored)** — When you are done, run **Start build with overrides** with `ACTION=destroy`, then delete the launcher stack itself to stop the charges. That completes the trilogy!",
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
              },
            ],
          },
        ],
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: SEQUENCE_PROBLEM_ID,
      name: "欠けた数",
      description:
        "次の数列には空欄が 1 つある:\n\n    2, 3, 5, 8, 13, ?, 34\n\n各項は、直前の 2 項の和になっている。",
      instructions: "`?` に入る数を求め、`TC{数字}` 形式で提出せよ (例: `TC{99}`)。",
      i18n: {
        en: {
          name: "The missing number",
          description:
            "One number is missing from this sequence:\n\n    2, 3, 5, 8, 13, ?, 34\n\nEach term is the sum of the previous two.",
          instructions: "Find the `?` and submit it as `TC{number}` (e.g. `TC{99}`).",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      // 未提出でデモを始める (= 訪問者が submit ボタンを押すまでの体験を作る)。
      score: 0,
      scoring: {
        kind: "flag",
        points: 300,
        flagSubmitted: false,
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: iso(-25 * MIN),
    },
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CIPHER_PROBLEM_ID,
      name: "隠された合言葉",
      description:
        "前任のエンジニアが、引き継ぎメモに ROT13 で暗号化した合言葉を残していった:\n\n    GP{jrypbzr_gb_grexnpybhq}\n\nROT13 はアルファベットを 13 文字ずらす暗号 (A↔N, B↔O, …)。数字や記号は変わらない。",
      instructions:
        "上の暗号を ROT13 で復号し、出てきた `TC{...}` をそのまま提出せよ。\n(ヒント: `T` は ROT13 で `G`。逆に `G` を戻すと `T`。)",
      i18n: {
        en: {
          name: "The hidden passphrase",
          description:
            "Your predecessor left a passphrase in the handover notes, encrypted with ROT13:\n\n    GP{jrypbzr_gb_grexnpybhq}\n\nROT13 shifts each letter by 13 (A↔N, B↔O, …). Digits and symbols are unchanged.",
          instructions:
            "Decode it with ROT13 and submit the `TC{...}` you get, verbatim.\n(Hint: `T` becomes `G` under ROT13, so `G` decodes back to `T`.)",
        },
      },
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {},
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 300,
      scoring: {
        kind: "flag",
        points: 300,
        flagSubmitted: true,
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
      totalProblems: 5,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 450,
      completedProblems: 1,
      totalProblems: 5,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 300,
      completedProblems: 1,
      totalProblems: 5,
      isMyTeam: true,
    },
    {
      rank: 4,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 300,
      completedProblems: 1,
      totalProblems: 5,
      isMyTeam: false,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 0,
      completedProblems: 0,
      totalProblems: 5,
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
      title: "オンボーディング 3 部作を開放",
      body: "「TenkaCloud を理解する」→「ローカルモードで遊ぶ」→「自分の TenkaCloud Lite を立てる」の順に進むと、理解から実デプロイまで得点しながら完走できます。詰まったら各提出欄のヒント(ペナルティなし)へ。",
      severity: "info",
      occurredAt: iso(-2 * MIN),
    },
    {
      notificationId: "notif-002",
      title: "ヒントが解放されました",
      body: `「${SEQUENCE_PROBLEM_ID}」のヒントが開放されました。ペナルティを払って閲覧できます。`,
      severity: "info",
      occurredAt: iso(-8 * MIN),
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud のデモを開始しました。オンボーディング 3 部作と 2 問のクエストが出題されています。解いて flag を提出しよう!",
      severity: "info",
      occurredAt: iso(-25 * MIN),
    },
  ],
};

/**
 * 自チームの score 変動履歴。 ScoreEventsPage が直接 fetch する API の dev-mock 版。
 * occurredAt 降順 (新しい順) で並べる。
 */
export const DEV_MOCK_SCORE_EVENTS: ScoreEventsResponse = {
  entries: [
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CIPHER_PROBLEM_ID,
      source: "flag",
      points: 300,
      result: "ok",
      occurredAt: iso(-3 * MIN),
    },
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CIPHER_PROBLEM_ID,
      source: "flag-wrong",
      points: -10,
      result: "wrong",
      occurredAt: iso(-6 * MIN),
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: SEQUENCE_PROBLEM_ID,
      source: "hint",
      points: -50,
      result: "ok",
      occurredAt: iso(-8 * MIN),
    },
  ],
};
