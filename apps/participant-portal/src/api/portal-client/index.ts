/**
 * Portal API client façade。 `apps/participant-portal/src/api/portal-client.ts` の
 * 旧来 1 ファイル shape をそのまま保ち、 既存 imports
 * (= `import { ... } from "../api/portal-client"`) が改修なしで通るようにする。
 *
 * 物理的には concern 別に分割している:
 *   - types.ts        — DTO / type aliases (`ParticipantTeamView`, `ScoreEventView` etc.)
 *   - errors.ts       — `PortalAuthError` / `PortalValidationError` 等の error class 階層
 *   - fetch.ts        — `portalFetch` 共通層 (401 / 400 / 409 / 500 mapping)
 *   - team.ts         — `getPortalMe` / `updateTeamName` / `getScoreEvents`
 *   - scoring.ts      — `submitFlag` / `revealHint`
 *   - lifecycle.ts    — `startProblem` / `stopProblem` (local-play on-demand container, #2392)
 *   - leaderboard.ts  — `getLeaderboard` / `getLeaderboardScoreEvents`
 *   - notifications.ts— `getNotifications`
 *   - sso.ts          — `getConsoleSigninUrl` / `getCliCredentials`
 *   - endpoints.ts    — endpoint override CRUD (3 fns)
 *   - problems.ts     — `getDeployLogs` / `getBattleAttacks`
 *   - terminal.ts     — `issueProblemTerminalHandoff` / `problemTerminalUrl` (local-play
 *     container shell, #2846)
 *
 * 新規 caller も index 経由を推奨 (= 個別ファイルに依存せず concern 移動に追随できる)。
 */

export * from "./endpoints";
export * from "./errors";
export * from "./leaderboard";
export * from "./lifecycle";
export * from "./notifications";
export * from "./problems";
export * from "./scoring";
export * from "./sso";
export * from "./team";
export * from "./terminal";
export * from "./types";
export * from "./workbench";
