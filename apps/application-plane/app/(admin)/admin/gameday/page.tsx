/**
 * Admin GameDay - Event Selection
 *
 * イベント一覧からGameDayイベントを選択するページ
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
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

function getGameStateSummary(gameState: GameState | null) {
  if (!gameState) {
    return {
      indicator: <StatusIndicator type="info">ゲーム未初期化</StatusIndicator>,
      details: 'ゲーム状態はまだ作成されていません',
    };
  }

  return {
    indicator: gameState.isRunning ? (
      <StatusIndicator type="success">進行中</StatusIndicator>
    ) : (
      <StatusIndicator type="stopped">停止中</StatusIndicator>
    ),
    details: `スコア重み: ${gameState.scoreWeight === 'high' ? '2x' : '通常'} / ブラックアウト: ${gameState.blackout ? 'ON' : 'OFF'} / ${gameState.durationMinutes}分`,
  };
}

export default function AdminGamedayPage() {
  const router = useRouter();
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
        (event) => event.type === 'gameday',
      );
      setEvents(gamedayEvents);

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
      setEvents((prev) => {
        if (prev.find((event) => event.id === state.eventId)) {
          return prev;
        }
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
    <SpaceBetween size="l">
      <Header variant="h1" description="GameDayイベントを選択してゲームを管理します">
        GameDay 管理
      </Header>

      <Container>
        {loading ? (
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        ) : error ? (
          <Box textAlign="center" padding="xxl">
            <SpaceBetween size="m" alignItems="center">
              <StatusIndicator type="error">{error.message}</StatusIndicator>
              <Button onClick={fetchEvents}>再読み込み</Button>
            </SpaceBetween>
          </Box>
        ) : events.length > 0 ? (
          <Cards
            cardsPerRow={[
              { cards: 1 },
              { minWidth: 520, cards: 2 },
            ]}
            items={events}
            cardDefinition={{
              header: (event) => (
                <NextLink
                  href={`/admin/gameday/${event.id}`}
                  className="text-[#539fe5] hover:underline"
                >
                  {event.name}
                </NextLink>
              ),
              sections: [
                {
                  id: 'event-id',
                  header: 'イベント ID',
                  content: (event) => (
                    <Box variant="code" color="text-body-secondary">
                      {event.id}
                    </Box>
                  ),
                },
                {
                  id: 'participants',
                  header: '参加者数',
                  content: (event) => `${event.participantCount ?? 0} 人`,
                },
                {
                  id: 'status',
                  header: 'ゲーム状態',
                  content: (event) => getGameStateSummary(gameStates[event.id]).indicator,
                },
                {
                  id: 'details',
                  header: '詳細',
                  content: (event) => (
                    <Box color="text-body-secondary">
                      {getGameStateSummary(gameStates[event.id]).details}
                    </Box>
                  ),
                },
              ],
            }}
            empty={<></>}
          />
        ) : (
          <Box textAlign="center" padding="xxl">
            <SpaceBetween size="m" alignItems="center">
              <Box variant="h2">GameDay イベントがありません</Box>
              <Box color="text-body-secondary">
                まずイベント管理から GameDay イベントを作成してください。
              </Box>
              <SpaceBetween direction="horizontal" size="s">
                <Button
                  variant="primary"
                  onClick={() => router.push('/admin/events/new')}
                >
                  新規イベント作成
                </Button>
                <Button onClick={() => router.push('/admin/events')}>
                  イベント管理へ
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          </Box>
        )}
      </Container>

      <Container
        header={
          <Header variant="h2" description="イベント ID を直接指定して GameDay 状態を確認します">
            直接検索
          </Header>
        }
      >
        <SpaceBetween size="m">
          <SpaceBetween direction="horizontal" size="s">
            <FormField label="イベント ID" stretch>
              <Input
                value={manualEventId}
                onChange={({ detail }) => setManualEventId(detail.value)}
                placeholder="event-id-here"
                onKeyDown={({ detail }) => {
                  if (detail.key === 'Enter') {
                    void handleLookup();
                  }
                }}
              />
            </FormField>
            <Button
              variant="primary"
              loading={lookupLoading}
              disabled={!manualEventId.trim() || lookupLoading}
              onClick={() => {
                void handleLookup();
              }}
            >
              検索
            </Button>
          </SpaceBetween>
          {lookupError && (
            <StatusIndicator type="error">{lookupError.message}</StatusIndicator>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
