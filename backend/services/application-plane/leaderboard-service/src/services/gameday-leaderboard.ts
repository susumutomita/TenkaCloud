/**
 * GameDay Leaderboard Service
 *
 * gameday-service の /dashboard/leaderboard からスコアを取得してリーダーボード形式に変換
 * ADR-003: Option A — GameDay のスコアを直接読み取る
 */

import { createLogger } from '../lib/logger';

const logger = createLogger('gameday-leaderboard');

export interface GameDayLeaderboardEntry {
  rank: number;
  teamId: string;
  teamName: string;
  score: number;
  attacksLaunched: number;
  attacksReceived: number;
  vulnerabilitiesFixed: number;
}

export interface GameDayLeaderboardResult {
  eventId: string;
  frozen: boolean;
  entries: GameDayLeaderboardEntry[];
  updatedAt: Date;
}

const GAMEDAY_API_URL =
  process.env.GAMEDAY_API_URL || 'http://localhost:3020/api/gameday';

/**
 * GameDay サービスからリーダーボードを取得
 */
export async function getGameDayLeaderboard(
  eventId: string,
  token?: string,
): Promise<GameDayLeaderboardResult | null> {
  try {
    const url = `${GAMEDAY_API_URL}/dashboard/leaderboard?eventId=${encodeURIComponent(eventId)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`GameDay API error: ${response.status}`);
    }

    const data = await response.json();
    const leaderboard = data.leaderboard ?? [];

    return {
      eventId,
      frozen: false,
      entries: leaderboard.map(
        (
          entry: {
            teamId: string;
            teamName: string;
            score: number;
            rank: number;
            attacksLaunched?: number;
            attacksReceived?: number;
            vulnerabilitiesFixed?: number;
          },
          index: number,
        ) => ({
          rank: entry.rank ?? index + 1,
          teamId: entry.teamId,
          teamName: entry.teamName,
          score: entry.score,
          attacksLaunched: entry.attacksLaunched ?? 0,
          attacksReceived: entry.attacksReceived ?? 0,
          vulnerabilitiesFixed: entry.vulnerabilitiesFixed ?? 0,
        }),
      ),
      updatedAt: new Date(),
    };
  } catch (error) {
    logger.error({ error, eventId }, 'GameDay リーダーボードの取得に失敗');
    return null;
  }
}
