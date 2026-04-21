'use client';

import { useCallback } from 'react';
import { getLeaderboardApiUrl } from '@/lib/api/backend-urls';
import { useIntervalPolling } from './use-interval-polling';

interface GameDayLeaderboardEntry {
  rank: number;
  teamId: string;
  teamName: string;
  score: number;
}

interface GameDayLeaderboardResult {
  eventId: string;
  entries: GameDayLeaderboardEntry[];
}

/**
 * Polls the GameDay leaderboard endpoint. Replaces the prior SSE hook — SSE
 * was removed so the leaderboard-service can run on Lambda.
 */
export function useLeaderboardPolling(eventId: string | undefined) {
  const fetcher = useCallback(async () => {
    if (!eventId) return null;
    const res = await fetch(
      `${getLeaderboardApiUrl()}/api/leaderboards/gameday/${eventId}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as GameDayLeaderboardResult;
  }, [eventId]);

  return useIntervalPolling(fetcher, { enabled: !!eventId });
}
