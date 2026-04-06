/**
 * Admin Events List Page
 *
 * Cloudscape Design System - Table-based event management
 * イベント管理一覧
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import type { SelectProps } from '@cloudscape-design/components/select';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import '@cloudscape-design/global-styles/index.css';

import type { AdminEvent, EventStatus } from '@/lib/api/admin-types';
import { del, patch } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';

function getNextStatusAction(
  status: EventStatus,
): { label: string; nextStatus: EventStatus } | null {
  switch (status) {
    case 'draft':
      return { label: '公開', nextStatus: 'scheduled' };
    case 'scheduled':
      return { label: '開始', nextStatus: 'active' };
    case 'active':
      return { label: '終了', nextStatus: 'completed' };
    case 'paused':
      return { label: '再開', nextStatus: 'active' };
    default:
      return null;
  }
}

const STATUS_OPTIONS: SelectProps.Option[] = [
  { label: 'すべて', value: '' },
  { label: '下書き', value: 'draft' },
  { label: '予定', value: 'scheduled' },
  { label: '開催中', value: 'active' },
  { label: '一時停止', value: 'paused' },
  { label: '終了', value: 'completed' },
  { label: 'キャンセル', value: 'cancelled' },
];

function getStatusIndicator(status: EventStatus) {
  switch (status) {
    case 'active':
      return <StatusIndicator type="success">開催中</StatusIndicator>;
    case 'scheduled':
      return <StatusIndicator type="pending">予定</StatusIndicator>;
    case 'completed':
      return <StatusIndicator type="stopped">終了</StatusIndicator>;
    case 'paused':
      return <StatusIndicator type="warning">一時停止</StatusIndicator>;
    case 'cancelled':
      return <StatusIndicator type="error">キャンセル</StatusIndicator>;
    case 'draft':
      return <StatusIndicator type="info">下書き</StatusIndicator>;
    default:
      return <StatusIndicator type="info">{status}</StatusIndicator>;
  }
}

function getTypeBadge(type: string) {
  switch (type) {
    case 'gameday':
      return <Badge color="blue">GameDay</Badge>;
    case 'jam':
      return <Badge color="green">Jam</Badge>;
    default:
      return <Badge>{type}</Badge>;
  }
}

export default function AdminEventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ status?: EventStatus }>({});
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [transitioningIds, setTransitioningIds] = useState<Set<string>>(
    new Set(),
  );

  const [selectedStatusOption, setSelectedStatusOption] =
    useState<SelectProps.Option>(STATUS_OPTIONS[0]);

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (filter.status) params.set('status', filter.status);

        const response = await fetch(`/api/admin/events?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `イベントの取得に失敗しました (${response.status})`,
          );
        }

        const data = await response.json();
        setEvents(data.events || []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'イベントの取得に失敗しました',
        );
        setEvents([]);
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [filter]);

  const filteredEvents = filter.status
    ? events.filter((e) => e.status === filter.status)
    : events;

  const handleDelete = async (event: AdminEvent) => {
    const confirmed = window.confirm(
      `「${event.name}」を削除しますか？この操作は取り消せません。`,
    );
    if (!confirmed) return;

    try {
      setDeletingIds((prev) => new Set(prev).add(event.id));
      await del(`/admin/events/${event.id}`);
      setFilter({ ...filter });
    } catch {
      window.alert('イベントの削除に失敗しました。再試行してください。');
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(event.id);
        return next;
      });
    }
  };

  const handleTransition = async (
    event: AdminEvent,
    nextStatus: EventStatus,
  ) => {
    try {
      setTransitioningIds((prev) => new Set(prev).add(event.id));
      await patch(`/admin/events/${event.id}`, { status: nextStatus });
      setFilter({ ...filter });
    } catch {
      window.alert(
        '\u30b9\u30c6\u30fc\u30bf\u30b9\u306e\u5909\u66f4\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u518d\u8a66\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
      );
    } finally {
      setTransitioningIds((prev) => {
        const next = new Set(prev);
        next.delete(event.id);
        return next;
      });
    }
  };

  const handleStatusFilterChange: SelectProps['onChange'] = ({ detail }) => {
    setSelectedStatusOption(detail.selectedOption);
    setFilter({
      status: (detail.selectedOption.value as EventStatus) || undefined,
    });
  };

  return (
    <Table
      variant="full-page"
      loading={loading}
      loadingText="イベントを読み込み中..."
      items={error ? [] : filteredEvents}
      empty={
        error ? (
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <StatusIndicator type="error">{error}</StatusIndicator>
              <Button onClick={() => setFilter({ ...filter })}>
                再読み込み
              </Button>
            </SpaceBetween>
          </Box>
        ) : (
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <Box variant="p" color="text-body-secondary">
                イベントがありません
              </Box>
              <Button
                variant="primary"
                onClick={() => router.push('/admin/events/new')}
              >
                新規イベント作成
              </Button>
            </SpaceBetween>
          </Box>
        )
      }
      header={
        <Header
          variant="awsui-h1-sticky"
          counter={`(${filteredEvents.length})`}
          actions={
            <NextLink href="/admin/events/new">
              <Button variant="primary">新規イベント</Button>
            </NextLink>
          }
        >
          イベント管理
        </Header>
      }
      filter={
        <Select
          selectedOption={selectedStatusOption}
          onChange={handleStatusFilterChange}
          options={STATUS_OPTIONS}
          placeholder="ステータスで絞り込み"
        />
      }
      columnDefinitions={[
        {
          id: 'name',
          header: 'イベント名',
          cell: (item) => (
            <Link
              href={`/admin/events/${item.id}`}
              onFollow={(e) => {
                e.preventDefault();
                router.push(`/admin/events/${item.id}`);
              }}
            >
              {item.name}
            </Link>
          ),
          sortingField: 'name',
        },
        {
          id: 'type',
          header: 'タイプ',
          cell: (item) => getTypeBadge(item.type),
        },
        {
          id: 'status',
          header: 'ステータス',
          cell: (item) => getStatusIndicator(item.status),
        },
        {
          id: 'startTime',
          header: '開始日時',
          cell: (item) => formatDateTime(item.startTime),
          sortingField: 'startTime',
        },
        {
          id: 'participants',
          header: '参加者',
          cell: (item) => `${item.participantCount} / ${item.maxParticipants}`,
        },
        {
          id: 'problems',
          header: '問題数',
          cell: (item) => `${item.problemCount} 問`,
        },
        {
          id: 'actions',
          header: '\u30a2\u30af\u30b7\u30e7\u30f3',
          cell: (item) => {
            const nextAction = getNextStatusAction(item.status);
            return (
              <SpaceBetween direction="horizontal" size="xs">
                {nextAction && (
                  <Button
                    variant="link"
                    loading={transitioningIds.has(item.id)}
                    onClick={() =>
                      handleTransition(item, nextAction.nextStatus)
                    }
                  >
                    {nextAction.label}
                  </Button>
                )}
                <Button
                  variant="link"
                  onClick={() => router.push(`/admin/events/${item.id}`)}
                >
                  {'\u7de8\u96c6'}
                </Button>
                <Button
                  variant="link"
                  loading={deletingIds.has(item.id)}
                  onClick={() => handleDelete(item)}
                >
                  {'\u524a\u9664'}
                </Button>
              </SpaceBetween>
            );
          },
        },
      ]}
    />
  );
}
