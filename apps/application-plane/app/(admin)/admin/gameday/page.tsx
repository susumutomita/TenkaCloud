/**
 * Admin GameDay - Event Selection
 *
 * イベント一覧からGameDayイベントを選択するページ
 */

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Input,
  Skeleton,
} from '@/components/ui';
import { get } from '@/lib/api/client';
import { getGameStatus } from '@/lib/api/gameday-admin';
import type { GameState } from '@/lib/api/gameday-types';

interface AdminEvent {
  id: string;
  name: string;
  type: string;
  status: string;
  startTime: string;
  participantCount: number;
}

export default function AdminGamedayPage() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [gameStates, setGameStates] = useState<
    Record<string, GameState | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [manualEventId, setManualEventId] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<Error | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await get<{ events: AdminEvent[] }>('/admin/events');
      const gamedayEvents = (data.events ?? []).filter(
        (e) => e.type === 'gameday',
      );
      setEvents(gamedayEvents);

      // Fetch game status for each event
      const states: Record<string, GameState | null> = {};
      await Promise.all(
        gamedayEvents.map(async (event) => {
          try {
            states[event.id] = await getGameStatus(event.id);
          } catch {
            states[event.id] = null;
          }
        }),
      );
      setGameStates(states);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('イベントの取得に失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handleLookup = useCallback(async () => {
    if (!manualEventId.trim()) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const state = await getGameStatus(manualEventId.trim());
      setGameStates((prev) => ({
        ...prev,
        [state.eventId]: state,
      }));
      // Add to events list if not present
      setEvents((prev) => {
        if (prev.find((e) => e.id === state.eventId)) return prev;
        return [
          ...prev,
          {
            id: state.eventId,
            name: state.eventId,
            type: 'gameday',
            status: state.isRunning ? 'active' : 'draft',
            startTime: state.startedAt ?? '',
            participantCount: 0,
          },
        ];
      });
      setManualEventId('');
    } catch (err) {
      setLookupError(
        err instanceof Error ? err : new Error('イベントが見つかりません'),
      );
    } finally {
      setLookupLoading(false);
    }
  }, [manualEventId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          GameDay 管理
        </h1>
        <p className="text-text-secondary mt-1">
          GameDayイベントを選択してゲームを管理します
        </p>
      </div>

      {/* Event List */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <ErrorState
          message={getErrorMessage(error)}
          type={getErrorType(error)}
          onRetry={fetchEvents}
        />
      ) : events.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {events.map((event) => {
            const gs = gameStates[event.id];
            return (
              <Card key={event.id} hoverable>
                <Link href={`/admin/gameday/${event.id}`}>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-text-primary">
                        {event.name}
                      </span>
                      <span
                        className={`w-3 h-3 rounded-full ${
                          gs?.isRunning
                            ? 'bg-hn-success animate-pulse'
                            : 'bg-text-muted'
                        }`}
                      />
                    </div>
                    <div className="text-sm font-mono text-text-muted">
                      {event.id}
                    </div>
                    <div className="flex items-center gap-3 text-sm text-text-muted">
                      {gs ? (
                        <>
                          <span>
                            スコア重み:{' '}
                            {gs.scoreWeight === 'high' ? '2x' : '通常'}
                          </span>
                          <span>
                            ブラックアウト: {gs.blackout ? 'ON' : 'OFF'}
                          </span>
                          <span>{gs.durationMinutes}分</span>
                        </>
                      ) : (
                        <span>ゲーム未初期化</span>
                      )}
                    </div>
                  </CardContent>
                </Link>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="text-center py-8">
          <p className="text-text-muted">GameDay イベントがありません</p>
          <Button variant="primary" asChild className="mt-4">
            <Link href="/admin/events/new">新規イベント作成</Link>
          </Button>
        </Card>
      )}

      {/* Manual Lookup */}
      <Card>
        <CardContent>
          <p className="text-sm text-text-muted mb-3">
            イベント ID を直接入力して検索することもできます
          </p>
          <div className="flex items-end gap-4">
            <Input
              label="イベント ID"
              value={manualEventId}
              onChange={(e) => setManualEventId(e.target.value)}
              placeholder="event-id-here"
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
            />
            <Button
              variant="secondary"
              onClick={handleLookup}
              loading={lookupLoading}
              disabled={!manualEventId.trim() || lookupLoading}
            >
              検索
            </Button>
          </div>
          {lookupError && (
            <p className="text-sm text-hn-error mt-2">
              {getErrorMessage(lookupError)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
