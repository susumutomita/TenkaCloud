/**
 * Admin GameDay - Event Selection
 *
 * イベント選択ページ
 */

'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Input,
} from '@/components/ui';
import { getGameStatus } from '@/lib/api/gameday-admin';
import type { GameState } from '@/lib/api/gameday-types';

export default function AdminGamedayPage() {
  const [eventId, setEventId] = useState('');
  const [gameStates, setGameStates] = useState<GameState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const handleLookup = useCallback(async () => {
    if (!eventId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const state = await getGameStatus(eventId.trim());
      setGameStates((prev) => {
        const exists = prev.find((g) => g.eventId === state.eventId);
        if (exists)
          return prev.map((g) => (g.eventId === state.eventId ? state : g));
        return [...prev, state];
      });
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('イベントが見つかりません')
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          GameDay 管理
        </h1>
        <p className="text-text-secondary mt-1">
          イベントIDを入力してゲームを管理します
        </p>
      </div>

      {/* Event Lookup */}
      <Card>
        <CardContent>
          <div className="flex items-end gap-4">
            <Input
              label="イベント ID"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              placeholder="event-id-here"
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
            />
            <Button
              variant="primary"
              onClick={handleLookup}
              loading={loading}
              disabled={!eventId.trim() || loading}
            >
              検索
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <ErrorState
          message={getErrorMessage(error)}
          type={getErrorType(error)}
          onRetry={handleLookup}
        />
      )}

      {/* Game States */}
      {gameStates.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">イベント</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {gameStates.map((gs) => (
              <Card key={gs.eventId} hoverable>
                <Link href={`/admin/gameday/${gs.eventId}`}>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-text-primary">
                        {gs.eventId}
                      </span>
                      <span
                        className={`w-3 h-3 rounded-full ${
                          gs.isRunning
                            ? 'bg-hn-success animate-pulse'
                            : 'bg-text-muted'
                        }`}
                      />
                    </div>
                    <div className="flex items-center gap-3 text-sm text-text-muted">
                      <span>
                        スコア重み: {gs.scoreWeight === 'high' ? '2x' : '通常'}
                      </span>
                      <span>ブラックアウト: {gs.blackout ? 'ON' : 'OFF'}</span>
                      <span>{gs.durationMinutes}分</span>
                    </div>
                  </CardContent>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
