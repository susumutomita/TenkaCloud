/**
 * Events List Page
 *
 * Cloudscape Design System — イベント一覧ページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '../../components/layout';
import { getAvailableEvents } from '../../lib/api/events';
import type {
  EventStatus,
  ParticipantEvent,
  ProblemType,
} from '../../lib/api/types';

const statusOptions: SelectProps.Option[] = [
  { value: '', label: 'すべて' },
  { value: 'active', label: '開催中' },
  { value: 'scheduled', label: '開催予定' },
];

const typeOptions: SelectProps.Option[] = [
  { value: '', label: 'すべて' },
  { value: 'gameday', label: 'GameDay' },
  { value: 'jam', label: 'JAM' },
];

function getEventStatusIndicator(status: EventStatus) {
  switch (status) {
    case 'active':
      return <StatusIndicator type="success">開催中</StatusIndicator>;
    case 'scheduled':
      return <StatusIndicator type="pending">開催予定</StatusIndicator>;
    case 'completed':
      return <StatusIndicator type="stopped">終了</StatusIndicator>;
    case 'cancelled':
      return <StatusIndicator type="error">キャンセル</StatusIndicator>;
    case 'paused':
      return <StatusIndicator type="warning">一時停止</StatusIndicator>;
    default:
      return <StatusIndicator type="info">{status}</StatusIndicator>;
  }
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getTimeUntilStart(startTime: string) {
  const now = new Date();
  const start = new Date(startTime);
  const diff = start.getTime() - now.getTime();

  if (diff <= 0) return null;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `あと ${days}日 ${hours}時間`;
  if (hours > 0) return `あと ${hours}時間`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `あと ${minutes}分`;
}

export default function EventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selectedStatus, setSelectedStatus] =
    useState<SelectProps.Option | null>(statusOptions[0]);
  const [selectedType, setSelectedType] = useState<SelectProps.Option | null>(
    typeOptions[0],
  );

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        const statusFilter = selectedStatus?.value
          ? [selectedStatus.value as EventStatus]
          : ['scheduled', 'active'];
        const res = await getAvailableEvents({
          status: statusFilter as EventStatus[],
          type: (selectedType?.value as ProblemType) || undefined,
          limit: 50,
        });
        setEvents(res.events);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました'),
        );
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [selectedStatus, selectedType]);

  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <Cards
            cardDefinition={{
              header: (event) => (
                <Link
                  href={`/events/${event.id}`}
                  fontSize="heading-m"
                  onFollow={(e) => {
                    e.preventDefault();
                    router.push(`/events/${event.id}`);
                  }}
                >
                  {event.name}
                </Link>
              ),
              sections: [
                {
                  id: 'status',
                  header: 'ステータス',
                  content: (event) => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {getEventStatusIndicator(event.status)}
                      <Badge
                        color={event.type === 'gameday' ? 'blue' : 'green'}
                      >
                        {event.type === 'gameday' ? 'GameDay' : 'JAM'}
                      </Badge>
                      {event.isRegistered && (
                        <Badge color="green">登録済み</Badge>
                      )}
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'schedule',
                  header: 'スケジュール',
                  content: (event) => {
                    const timeUntil =
                      event.status === 'scheduled'
                        ? getTimeUntilStart(event.startTime)
                        : null;
                    return (
                      <SpaceBetween size="xxs">
                        <Box variant="small">
                          開始: {formatDate(event.startTime)}
                        </Box>
                        <Box variant="small">
                          終了: {formatDate(event.endTime)}
                        </Box>
                        {timeUntil && (
                          <Box color="text-status-info" fontWeight="bold">
                            {timeUntil}
                          </Box>
                        )}
                      </SpaceBetween>
                    );
                  },
                },
                {
                  id: 'details',
                  header: '詳細',
                  content: (event) => (
                    <SpaceBetween direction="horizontal" size="l">
                      <Box variant="small">
                        問題数:{' '}
                        <Box variant="span" fontWeight="bold">
                          {event.problemCount}
                        </Box>
                      </Box>
                      <Box variant="small">
                        参加者:{' '}
                        <Box variant="span" fontWeight="bold">
                          {event.participantCount}
                        </Box>
                      </Box>
                      <Box variant="small">
                        {event.cloudProvider.toUpperCase()}
                      </Box>
                      <Box variant="small">
                        {event.participantType === 'team'
                          ? 'チーム参加'
                          : '個人参加'}
                      </Box>
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'action',
                  content: (event) => (
                    <Button
                      variant={event.status === 'active' ? 'primary' : 'normal'}
                      fullWidth
                      onClick={() => router.push(`/events/${event.id}`)}
                    >
                      {event.status === 'active'
                        ? event.isRegistered
                          ? 'バトルに参加'
                          : '今すぐ参加'
                        : event.isRegistered
                          ? '詳細を見る'
                          : '登録する'}
                    </Button>
                  ),
                },
              ],
            }}
            cardsPerRow={[
              { cards: 1 },
              { minWidth: 600, cards: 2 },
              { minWidth: 1000, cards: 3 },
            ]}
            items={events}
            loading={loading}
            loadingText="イベントを読み込み中..."
            header={
              <Header
                counter={!loading && !error ? `(${events.length})` : undefined}
                description="参加可能なイベントを確認して、クラウドバトルに挑もう"
              >
                イベント一覧
              </Header>
            }
            filter={
              <SpaceBetween direction="horizontal" size="l">
                <Select
                  selectedOption={selectedStatus}
                  onChange={({ detail }) =>
                    setSelectedStatus(detail.selectedOption)
                  }
                  options={statusOptions}
                  placeholder="ステータス"
                />
                <Select
                  selectedOption={selectedType}
                  onChange={({ detail }) =>
                    setSelectedType(detail.selectedOption)
                  }
                  options={typeOptions}
                  placeholder="タイプ"
                />
              </SpaceBetween>
            }
            empty={
              error ? (
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <StatusIndicator type="error">
                      {error.message}
                    </StatusIndicator>
                    <Button onClick={() => window.location.reload()}>
                      再試行
                    </Button>
                  </SpaceBetween>
                </Box>
              ) : (
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <b>イベントが見つかりません</b>
                    <Box variant="p" color="inherit">
                      条件に一致するイベントがありません。
                    </Box>
                  </SpaceBetween>
                </Box>
              )
            }
          />
        </div>
      </main>
    </div>
  );
}
