import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
  ScoreEventsResponse,
} from "../api/portal-client";

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state
 * になってしまう (= LP の 「モックで試す」 動線で competitor が操作できなくなる)。
 *
 * 本 module は dev-mock 起動時に各 page が seed する固定 fixture を提供する。
 * production (= backend mode) では参照されない (= caller 側で `if (isBackend) return`
 * ガードする想定)。
 *
 * 内容は 「AWS ハンズオン演習」 として一目で分かる 2 問構成 (= 利用者方針):
 *   - 1 Challenge (= S3 静的 site でホスト + flag 提出)
 *   - 1 Battle   (= Lambda + API Gateway の uptime 維持)
 *
 * 過剰に問題を増やすと 「何を見せたいか」 がブレるので、 demo は 2 問固定。
 */

const NOW_ISO = "2026-05-22T13:42:00Z";
const DEPLOY_EXPIRES_AT = Math.floor(Date.parse("2026-05-22T19:42:00Z") / 1000);

const CHALLENGE_PROBLEM_ID = "s3-static-site-hosting";
const BATTLE_PROBLEM_ID = "lambda-api-uptime";

export const DEV_MOCK_TEAM_VIEW: ParticipantTeamView = {
  team: {
    teamId: "team-demo-1",
    teamName: "Demo Team",
    teamNameSetByCompetitor: true,
    eventId: "evt-demo-2026-05-22",
  },
  problems: [
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CHALLENGE_PROBLEM_ID,
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {
        WebsiteEndpoint: "https://demo-tenkacloud-static.s3-website-ap-northeast-1.amazonaws.com/",
      },
      expiresAt: DEPLOY_EXPIRES_AT,
      // 未提出状態でデモを始める (= LP visitor が submit ボタンを押すまでの体験を作る)。
      // flag が正解になったあとの体験は FlagSubmissionPanel が local state で celebration を
      // 出すので、 view 側の更新は必須ではない。
      score: 0,
      scoring: {
        kind: "flag",
        points: 800,
        flagSubmitted: false,
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: "2026-05-22T13:00:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {
        ApiEndpoint: "https://demo-api.execute-api.ap-northeast-1.amazonaws.com/prod/health",
      },
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 420,
      lastScoredAt: "2026-05-22T13:41:00Z",
      lastResult: "ok",
      scoring: {
        kind: "uptime",
        pointsPerSuccess: 60,
      },
      applicationStatus: {
        overall: "healthy",
        healthyCount: 1,
        totalCount: 1,
        checkedAt: "2026-05-22T13:41:00Z",
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: "2026-05-22T13:00:00Z",
    },
  ],
  eventGate: { kind: "ok" },
};

export const DEV_MOCK_LEADERBOARD: LeaderboardResponse = {
  eventId: "evt-demo-2026-05-22",
  entries: [
    {
      rank: 1,
      teamId: "team-alpha",
      teamName: "Alpha Squad",
      score: 1620,
      completedProblems: 2,
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 1480,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 1220,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: true,
    },
    {
      rank: 4,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 940,
      completedProblems: 1,
      totalProblems: 2,
      isMyTeam: false,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 720,
      completedProblems: 0,
      totalProblems: 2,
      isMyTeam: false,
    },
  ],
  scoreboardFrozen: false,
  endsAt: "2026-05-22T19:00:00Z",
};

export const DEV_MOCK_NOTIFICATIONS: NotificationsResponse = {
  eventId: "evt-demo-2026-05-22",
  items: [
    {
      notificationId: "notif-002",
      title: "ヒントが解放されました",
      body: `${BATTLE_PROBLEM_ID} の Phase 2 ヒントが開放されました。 ペナルティを払って閲覧できます。`,
      severity: "info",
      occurredAt: "2026-05-22T13:30:00Z",
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud Battle (demo) を開始しました。 各チームに 2 問が deploy されています。 頑張ってください!",
      severity: "info",
      occurredAt: NOW_ISO,
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
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "uptime",
      points: 60,
      result: "ok",
      occurredAt: "2026-05-22T13:41:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "uptime",
      points: 60,
      result: "ok",
      occurredAt: "2026-05-22T13:40:00Z",
    },
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CHALLENGE_PROBLEM_ID,
      source: "flag",
      points: 800,
      result: "ok",
      occurredAt: "2026-05-22T13:38:11Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "hint",
      points: -50,
      result: "ok",
      occurredAt: "2026-05-22T13:35:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "uptime",
      points: 60,
      result: "ok",
      occurredAt: "2026-05-22T13:31:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "uptime",
      points: 60,
      result: "ok",
      occurredAt: "2026-05-22T13:21:00Z",
    },
    {
      jobId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
      problemId: CHALLENGE_PROBLEM_ID,
      source: "flag-wrong",
      points: -10,
      result: "wrong",
      occurredAt: "2026-05-22T13:15:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: BATTLE_PROBLEM_ID,
      source: "uptime",
      points: 60,
      result: "ok",
      occurredAt: "2026-05-22T13:01:00Z",
    },
  ],
};
