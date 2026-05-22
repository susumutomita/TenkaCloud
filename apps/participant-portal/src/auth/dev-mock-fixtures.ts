import type {
  LeaderboardResponse,
  NotificationsResponse,
  ParticipantTeamView,
} from "../api/portal-client";

/**
 * `mode === "dev-mock"` のとき backend が存在しないので、 portal の各画面が空 state
 * になってしまう (= LP の 「モックで試す」 動線でユーザーが操作できなくなる)。
 *
 * 本 module は TeamViewProvider が dev-mock 起動時に seed する固定 fixture を提供する。
 * production (= backend mode) では参照されない (= bundle dead-code 化される — Vite の
 * tree-shake と `import.meta.env.MODE !== "test"` ガードは不要、 caller 側で if 分岐
 * してくれば OK)。
 *
 * 内容は実イベントを想像できる形にしたい:
 *   - 3 problem (hello-world / hello-world-battle / microservice-migration-battle)
 *   - 6 team の leaderboard (= デモチームが上位、 競争感を出す)
 *   - 2 通の operator notification (= 開始 + ヒント reveal)
 */

const NOW_ISO = "2026-05-22T13:42:00Z";
const DEPLOY_EXPIRES_AT = Math.floor(Date.parse("2026-05-22T19:42:00Z") / 1000);

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
      problemId: "hello-world",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {
        Endpoint: "https://hello-world.demo.tenkacloud.example/",
      },
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 800,
      lastScoredAt: "2026-05-22T13:38:11Z",
      lastResult: "ok",
      scoring: {
        kind: "flag",
        points: 800,
        flagSubmitted: true,
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: "2026-05-22T13:00:00Z",
    },
    {
      jobId: "01HZX0KFFCT7BHGAQM6Q2WP1AB",
      problemId: "hello-world-battle",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {
        Endpoint: "https://hello-world-battle.demo.tenkacloud.example/",
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
        healthyCount: 3,
        totalCount: 3,
        checkedAt: "2026-05-22T13:41:00Z",
      },
      deployLog: { cursor: "", entries: [] },
      createdAt: "2026-05-22T13:00:00Z",
    },
    {
      jobId: "01HZX0KKJ9T75GMRJWPC36KS81",
      problemId: "microservice-migration-battle",
      region: "us-east-1",
      awsAccountId: "999999999999",
      status: "COMPLETE",
      stackOutputs: {
        Endpoint: "https://migration.demo.tenkacloud.example/",
      },
      expiresAt: DEPLOY_EXPIRES_AT,
      score: 180,
      lastScoredAt: "2026-05-22T13:40:30Z",
      lastResult: "fail",
      scoring: {
        kind: "uptime-multi",
      },
      applicationStatus: {
        overall: "degraded",
        healthyCount: 2,
        totalCount: 3,
        checkedAt: "2026-05-22T13:40:30Z",
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
      score: 1860,
      completedProblems: 2,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 2,
      teamId: "team-bravo",
      teamName: "Bravo Crew",
      score: 1640,
      completedProblems: 2,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 3,
      teamId: "team-demo-1",
      teamName: "Demo Team",
      score: 1400,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: true,
    },
    {
      rank: 4,
      teamId: "team-delta",
      teamName: "Delta Force",
      score: 1120,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 5,
      teamId: "team-echo",
      teamName: "Echo Five",
      score: 940,
      completedProblems: 1,
      totalProblems: 3,
      isMyTeam: false,
    },
    {
      rank: 6,
      teamId: "team-foxtrot",
      teamName: "Foxtrot Six",
      score: 720,
      completedProblems: 0,
      totalProblems: 3,
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
      body: "hello-world-battle の Phase 2 ヒントが開放されました。 ペナルティを払って閲覧できます。",
      severity: "info",
      occurredAt: "2026-05-22T13:30:00Z",
    },
    {
      notificationId: "notif-001",
      title: "競技開始",
      body: "TenkaCloud Battle (demo) を開始しました。 各チームに 3 問が deploy されています。 頑張ってください!",
      severity: "info",
      occurredAt: NOW_ISO,
    },
  ],
};
