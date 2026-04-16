'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// --- Types (mirrored from realtime-service for frontend use) ---

export interface LeaderboardEntry {
  teamId: string;
  teamName: string;
  score: number;
  rank: number;
}

export type RealtimeEvent =
  | { type: 'score_update'; teamId: string; score: number; rank: number }
  | {
      type: 'attack_executed';
      attackerTeamId: string;
      defenderTeamId: string;
      attackSlug: string;
    }
  | {
      type: 'game_state_changed';
      isRunning: boolean;
      scoreWeight: string;
      blackout: boolean;
    }
  | { type: 'leaderboard_update'; entries: LeaderboardEntry[] };

export type ServerMessage =
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'joined'; eventId: string }
  | { type: 'left'; eventId: string }
  | RealtimeEvent;

type Subscriber = (event: RealtimeEvent) => void;

export interface UseRealtimeReturn {
  isConnected: boolean;
  lastEvent: RealtimeEvent | null;
  subscribe: (callback: Subscriber) => () => void;
}

const REALTIME_EVENT_TYPES = new Set([
  'score_update',
  'attack_executed',
  'game_state_changed',
  'leaderboard_update',
]);

const HEARTBEAT_INTERVAL = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

const WS_BASE_URL =
  process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:3013';

function getWsUrl(eventId: string, token: string): string {
  return `${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}&eventId=${encodeURIComponent(eventId)}`;
}

export function useRealtime(
  eventId: string | undefined,
  token?: string,
): UseRealtimeReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const mountedRef = useRef(true);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const subscribe = useCallback((callback: Subscriber) => {
    subscribersRef.current.add(callback);
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!eventId || !token) return;

    let currentWs: WebSocket | null = null;

    const connect = () => {
      const url = getWsUrl(eventId, token);
      const ws = new WebSocket(url);
      currentWs = ws;
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (!mountedRef.current) return;
        setIsConnected(true);
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;

        // ルームに参加
        ws.send(JSON.stringify({ action: 'join', eventId }));

        // ハートビート開始
        clearHeartbeat();
        heartbeatRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL);
      });

      ws.addEventListener('message', (event) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data as string) as ServerMessage;

          if (REALTIME_EVENT_TYPES.has(data.type)) {
            const realtimeEvent = data as RealtimeEvent;
            setLastEvent(realtimeEvent);
            for (const subscriber of subscribersRef.current) {
              subscriber(realtimeEvent);
            }
          }
        } catch {
          // JSON パースエラーは無視
        }
      });

      ws.addEventListener('close', () => {
        if (!mountedRef.current) return;
        setIsConnected(false);
        clearHeartbeat();

        // 指数バックオフで再接続
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);

        clearReconnectTimeout();
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        // close イベントが後に発火するため、ここでは何もしない
      });
    };

    connect();

    return () => {
      mountedRef.current = false;
      clearHeartbeat();
      clearReconnectTimeout();
      currentWs?.close();
      wsRef.current = null;
      setIsConnected(false);
    };
  }, [eventId, token, clearHeartbeat, clearReconnectTimeout]);

  return { isConnected, lastEvent, subscribe };
}
