'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLeaderboardApiUrl } from '@/lib/api/backend-urls';

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

interface UseLeaderboardPollingReturn {
  data: GameDayLeaderboardResult | null;
  error: string | null;
  connected: boolean;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Polls the GameDay leaderboard endpoint every 5 seconds. Replaces the prior
 * SSE hook — SSE was removed so the leaderboard-service can run on Lambda.
 */
export function useLeaderboardPolling(
  eventId: string | undefined,
): UseLeaderboardPollingReturn {
  const [data, setData] = useState<GameDayLeaderboardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!eventId) return;
    try {
      const baseUrl = getLeaderboardApiUrl();
      const res = await fetch(`${baseUrl}/api/leaderboards/gameday/${eventId}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setConnected(false);
        return;
      }
      const parsed = (await res.json()) as GameDayLeaderboardResult;
      setData(parsed);
      setError(null);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Leaderboard fetch failed');
      setConnected(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchOnce();
    intervalRef.current = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchOnce]);

  return { data, error, connected };
}
