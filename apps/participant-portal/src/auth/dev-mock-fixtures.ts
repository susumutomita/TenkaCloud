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
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 450,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 300,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: true,
    },
    {
      rank: 4,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 300,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 0,
      completedProblems: 0,
      totalProblems: 2,
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
      notificationId: "notif-002",
      title: "ヒントが解放されました",
      body: `「${SEQUENCE_PROBLEM_ID}」のヒントが開放されました。ペナルティを払って閲覧できます。`,
      severity: "info",
      occurredAt: iso(-8 * MIN),
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud のデモを開始しました。2 問のクエストが出題されています。解いて flag を提出しよう!",
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
