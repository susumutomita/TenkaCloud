import { LITE_DRILL_CHECKPOINTS, LITE_DRILL_PROBLEM_ID } from "@tenkacloud/portal-contracts";
import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
  ScoreEventsResponse,
} from "../api/portal-client";

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state に
 * なってしまう (= LP の「モックで試す」動線で competitor が操作できなくなる)。
 *
 * 本 module は dev-mock 起動時に各 page が seed する fixture を提供する。
 * production (= backend mode) では参照されない (= caller 側で `if (isBackend) return` ガード)。
 *
 * 方針 (= 公開デモ): AWS に依存しない、その場で解ける「クエスト」2 問にする。
 *   - どちらも flag 提出型なので、 endpoint (= クリックで 404 する偽 URL) を持たない。
 *   - 問題文 (name / description / instructions) を同梱し「何をするか」を明示する。
 *   - 1 問は解答済み (celebration 済みの状態)、 もう 1 問は未解答 (訪問者が解ける)。
 *
 * 加えて Issue #2696: 「自分の TenkaCloud Lite を立てる」 実践ドリルを 1 問固定出題する。
 * これはデモ内で完結しない唯一の問題で、 学習者が実際に自分の AWS アカウントへ Lite mode
 * を deploy → Competitor アカウント検証 → 初回イベント作成、 と進むたびに実環境の各画面に
 * 印字されるチェックポイントコード (`@tenkacloud/portal-contracts` の lite-drill 契約) を
 * この demo portal に提出して得点する。 デモ (A ルート「まず遊ぶ」) から実デプロイ (B ルート
 * 「イベントを開く」) への導線をゲームとして一本化するのが狙い。
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
      jobId: "01HZX0KZZ3DR0PW9M4Q7XV2C5D",
      problemId: LITE_DRILL_PROBLEM_ID,
      name: "自分の TenkaCloud Lite を立てる",
      description:
        "デモの外に出て、自分の AWS アカウントに本物の TenkaCloud Lite を立ち上げる実践ドリル。" +
        "手順を正しく実行するたびに、実環境の画面にチェックポイントコード TENKA{...} が現れる。" +
        "それをこの画面に提出して得点しよう。\n\n" +
        "はじめる前に:\n" +
        "- 管理者相当の権限で使える AWS アカウントと、受信できるメールアドレスが必要\n" +
        "- デプロイ中はデフォルト構成で約 $7/月の継続費用が発生する (遊び終えたら手順 5 で必ず片付ける)\n" +
        "- launcher は CodeBuild 用に広い権限の IAM Role を作成する (CloudFormation の IAM acknowledge で明示同意する)",
      instructions:
        "1. README の Quickstart から lite-pipeline.yaml で CloudFormation スタックを作成する (必須入力は TenantAdminEmail のみ)。" +
        "作成完了後、スタックの「出力 (Outputs)」タブの OnboardingDrillCheckpoint の値を「1. Launcher スタック作成」に提出。\n" +
        "2. Outputs の StartBuildConsoleUrl から CodeBuild を開き「ビルドを開始」。ログ末尾の「✓ Lite mode deploy complete」ブロックのコードを「2. Lite デプロイ完了」に提出。\n" +
        "3. 招待メールの一時パスワードで Application Admin Console にサインインし、Competitor Accounts で競技用 AWS アカウントを登録 → bootstrap テンプレートを競技側アカウントに適用 → 「検証」。成功表示のコードを「3. Competitor アカウント検証」に提出。\n" +
        "4. Events タブで最初のイベントを作成する (チームに検証済みアカウントを割り当てる)。作成成功画面のコードを「4. 初回イベント作成」に提出。\n" +
        "5. 遊び終えたら CodeBuild の「Start build with overrides」で ACTION=destroy を実行し、最後に launcher スタックを削除して課金を止める。",
      i18n: {
        en: {
          name: "Deploy your own TenkaCloud Lite",
          description:
            "Step outside the demo and stand up a real TenkaCloud Lite in your own AWS account. " +
            "Each step you complete reveals a TENKA{...} checkpoint code on the real screens — " +
            "paste it back here to score.\n\n" +
            "Before you start:\n" +
            "- You need an AWS account with admin-level access and an email address you can read\n" +
            "- The default profile costs about $7/month while deployed (step 5 tears it down)\n" +
            "- The launcher creates a broad-permission IAM Role for CodeBuild (you acknowledge it in CloudFormation)",
          instructions:
            "1. Create the CloudFormation stack from lite-pipeline.yaml via the README Quickstart (TenantAdminEmail is the only required field). " +
            'When it completes, submit the OnboardingDrillCheckpoint value from the stack\'s "Outputs" tab to "1. Launcher stack created".\n' +
            '2. Open the CodeBuild project via the StartBuildConsoleUrl output and press "Start build". Submit the code printed in the "Lite mode deploy complete" block at the end of the log to "2. Lite deploy complete".\n' +
            '3. Sign in to the Application Admin Console with the invite email, register a competitor AWS account under Competitor Accounts, apply the bootstrap template in that account, then press "Verify". Submit the code from the success message to "3. Competitor account verified".\n' +
            '4. Create your first event on the Events tab (assign the verified account to a team). Submit the code shown on the success screen to "4. First event created".\n' +
            '5. When you are done, run "Start build with overrides" with ACTION=destroy, then delete the launcher stack to stop the charges.',
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
          },
          {
            id: LITE_DRILL_CHECKPOINTS.deployComplete.flagId,
            label: "2. Lite デプロイ完了",
            points: 100,
            solved: false,
            i18n: { en: { label: "2. Lite deploy complete" } },
          },
          {
            id: LITE_DRILL_CHECKPOINTS.competitorVerified.flagId,
            label: "3. Competitor アカウント検証",
            points: 100,
            solved: false,
            i18n: { en: { label: "3. Competitor account verified" } },
          },
          {
            id: LITE_DRILL_CHECKPOINTS.firstEventCreated.flagId,
            label: "4. 初回イベント作成",
            points: 100,
            solved: false,
            i18n: { en: { label: "4. First event created" } },
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
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 450,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 300,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: true,
    },
    {
      rank: 4,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 300,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 0,
      completedProblems: 0,
      totalProblems: 3,
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
      title: "実践ドリル開放",
      body: "「自分の TenkaCloud Lite を立てる」ドリルが追加されました。自分の AWS アカウントに本物の TenkaCloud を立ち上げ、各手順で現れるチェックポイントコードを提出しよう。",
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
      body: "TenkaCloud のデモを開始しました。2 問のクエストと 1 つの実践ドリルが出題されています。解いて flag を提出しよう!",
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
