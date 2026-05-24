import { portalFetch } from "./fetch";
import type { LeaderboardResponse, LeaderboardScoreEventsResponse } from "./types";

/**
 * Leaderboard / Scoreboard 系 endpoints (= event scope の team ランキング + 累計スコア推移)。
 * 旧 jobId-based deployment (= eventId 無し) は 404 → undefined を返し、 caller は
 * 「scoreboard 非対応」 path に fall back する。
 */

/**
 * `GET /portal/leaderboard` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * 旧 jobId-based deployment で eventId が無い場合は 404 → undefined を返す。
 */
export async function getLeaderboard(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<LeaderboardResponse | undefined> {
  return await portalFetch<LeaderboardResponse>(apiBaseUrl, "portal/leaderboard", teamLoginKey, {
    returnUndefinedOn404: true,
    signal,
  });
}

/**
 * `GET /portal/leaderboard/score-events` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * 旧 jobId-based deployment (= eventId 無し) は 404 → undefined を返す (= ScoreTimelineChart
 * 側で自チームのみ chart を出す path に fall back する想定)。
 */
export async function getLeaderboardScoreEvents(
  apiBaseUrl: string,
  teamLoginKey: string,
  signal?: AbortSignal,
): Promise<LeaderboardScoreEventsResponse | undefined> {
  return await portalFetch<LeaderboardScoreEventsResponse>(
    apiBaseUrl,
    "portal/leaderboard/score-events",
    teamLoginKey,
    { returnUndefinedOn404: true, signal },
  );
}
