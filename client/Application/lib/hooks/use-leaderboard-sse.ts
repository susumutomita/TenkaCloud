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

interface UseLeaderboardSSEReturn {
  data: GameDayLeaderboardResult | null;
  error: string | null;
  connected: boolean;
}

export function useLeaderboardSSE(
  eventId: string | undefined,
): UseLeaderboardSSEReturn {
  const [data, setData] = useState<GameDayLeaderboardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (!eventId) return;

    const baseUrl = getLeaderboardApiUrl();
    const url = `${baseUrl}/api/leaderboards/gameday/${eventId}/stream`;
    const es = new EventSource(url);

    es.addEventListener('leaderboard', (event) => {
      const parsed = JSON.parse(event.data) as GameDayLeaderboardResult;
      setData(parsed);
      setError(null);
      setConnected(true);
    });

    es.addEventListener('error', (event) => {
      if (event instanceof MessageEvent) {
        const parsed = JSON.parse(event.data) as { error: string };
        setError(parsed.error);
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    eventSourceRef.current = es;
  }, [eventId]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connect]);

  return { data, error, connected };
}
