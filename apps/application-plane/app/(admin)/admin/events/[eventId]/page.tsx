/**
 * Admin Event Detail Page
 *
 * Cloudscape Design System — イベント詳細ビュー
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { AdminEvent, EventStatus } from '@/lib/api/admin-types';
import type { ChallengeProblem } from '@/lib/api/types';
import { get, put } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface EventDetailData extends AdminEvent {
  problems?: ChallengeProblem[];
}

// =============================================================================
// Helpers
// =============================================================================

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

interface StatusAction {
  label: string;
  status: EventStatus;
  variant: 'primary' | 'normal';
}

/**
 * 現在のステータスから有効な遷移アクションを返す
 */
function getStatusActions(current: EventStatus): StatusAction[] {
  switch (current) {
    case 'draft':
      return [{ label: '公開する', status: 'scheduled', variant: 'primary' }];
    case 'scheduled':
      return [
        { label: '開始する', status: 'active', variant: 'primary' },
        { label: 'キャンセル', status: 'cancelled', variant: 'normal' },
      ];
    case 'active':
      return [
        { label: '一時停止', status: 'paused', variant: 'normal' },
        { label: '終了する', status: 'completed', variant: 'primary' },
      ];
    case 'paused':
      return [
        { label: '再開する', status: 'active', variant: 'primary' },
        { label: 'キャンセル', status: 'cancelled', variant: 'normal' },
      ];
    case 'completed':
      return [{ label: 'キャンセル', status: 'cancelled', variant: 'normal' }];
    default:
      return [];
  }
}

// =============================================================================
// Component
// =============================================================================

export default function AdminEventDetailPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const fetchEvent = useCallback(async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const data = await get<EventDetailData>(`/admin/events/${eventId}`);
      setEvent(data);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : 'イベントの取得に失敗しました',
      );
      setEvent(null);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchEvent();
  }, [fetchEvent]);

  const handleStatusTransition = async (nextStatus: EventStatus) => {
    try {
      setTransitioning(true);
      await put(`/admin/events/${eventId}`, { status: nextStatus });
      await fetchEvent();
    } catch {
      // エラーは fetchEvent 内でハンドリング
    } finally {
      setTransitioning(false);
    }
  };

  // Loading
  if (loading) {
    return (
      <Box textAlign="center" padding="xl">
        <Spinner size="large" />
      </Box>
    );
  }

  // Error
  if (fetchError) {
    return (
      <Box textAlign="center" padding="xl">
        <SpaceBetween size="m">
          <StatusIndicator type="error">{fetchError}</StatusIndicator>
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => router.push('/admin/events')}>
              イベント一覧に戻る
            </Button>
            <Button onClick={fetchEvent}>再読み込み</Button>
          </SpaceBetween>
        </SpaceBetween>
      </Box>
    );
  }

  // Not found
  if (!event) {
    return (
      <Box textAlign="center" padding="xl">
        <SpaceBetween size="m">
          <Box variant="h2">イベントが見つかりません</Box>
          <Button onClick={() => router.push('/admin/events')}>
            イベント一覧に戻る
          </Button>
        </SpaceBetween>
      </Box>
    );
  }

  const actions = getStatusActions(event.status);

  return (
    <SpaceBetween size="l">
      {/* Header */}
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            {actions.map((action) => (
              <Button
                key={action.status}
                variant={action.variant}
                loading={transitioning}
                onClick={() => handleStatusTransition(action.status)}
              >
                {action.label}
              </Button>
            ))}
            <Button
              onClick={() => router.push(`/admin/events/${eventId}/edit`)}
            >
              編集
            </Button>
            <Button onClick={() => router.push('/admin/events')}>
              イベント一覧に戻る
            </Button>
          </SpaceBetween>
        }
      >
        {event.name}
      </Header>

      {/* Overview */}
      <Container
        header={
          <Header
            variant="h2"
            info={
              <SpaceBetween direction="horizontal" size="xs">
                {getTypeBadge(event.type)}
                {getStatusIndicator(event.status)}
              </SpaceBetween>
            }
          >
            基本情報
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            items={[
              {
                label: '開始日時',
                value: event.startTime ? formatDateTime(event.startTime) : '-',
              },
              {
                label: '終了日時',
                value: event.endTime ? formatDateTime(event.endTime) : '-',
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: '参加者数',
                value: `${event.participantCount} / ${event.maxParticipants}`,
              },
              {
                label: '参加形式',
                value: event.participantType === 'team' ? 'チーム' : '個人',
              },
            ]}
          />
        </ColumnLayout>
        {event.description && (
          <Box margin={{ top: 'l' }}>
            <Box variant="awsui-key-label">説明</Box>
            <Box>{event.description}</Box>
          </Box>
        )}
      </Container>

      {/* GameDay Quick Actions (only for gameday events) */}
      {event.type === 'gameday' && (
        <Container header={<Header variant="h2">GameDay 管理</Header>}>
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="primary"
              onClick={() => router.push(`/admin/gameday/${eventId}`)}
            >
              ゲーム制御パネル
            </Button>
            <Button
              onClick={() => router.push(`/admin/events/${eventId}/attacks`)}
            >
              攻撃カタログ
            </Button>
            <Button
              onClick={() => router.push(`/admin/events/${eventId}/problems`)}
            >
              問題管理
            </Button>
          </SpaceBetween>
        </Container>
      )}

      {/* JAM Quick Actions (only for jam events) */}
      {event.type === 'jam' && (
        <Container header={<Header variant="h2">JAM 管理</Header>}>
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              variant="primary"
              onClick={() => router.push(`/admin/events/${eventId}/problems`)}
            >
              問題管理
            </Button>
          </SpaceBetween>
        </Container>
      )}

      {/* Problems table */}
      <Table
        header={
          <Header
            variant="h2"
            counter={`(${event.problems?.length ?? 0})`}
            actions={
              <Button
                onClick={() =>
                  router.push(`/admin/events/${eventId}/problems/new`)
                }
              >
                問題を追加
              </Button>
            }
          >
            問題一覧
          </Header>
        }
        items={event.problems ?? []}
        empty={
          <Box textAlign="center" padding="l">
            <Box variant="p" color="text-body-secondary">
              問題がまだありません
            </Box>
          </Box>
        }
        columnDefinitions={[
          {
            id: 'title',
            header: 'タイトル',
            cell: (item) => (
              <Link
                href={`/admin/problems/${item.id}`}
                onFollow={(e) => {
                  e.preventDefault();
                  router.push(`/admin/problems/${item.id}`);
                }}
              >
                {item.title}
              </Link>
            ),
          },
          {
            id: 'points',
            header: 'ポイント',
            cell: (item) => `${item.maxScore ?? 0} pts`,
          },
        ]}
      />
    </SpaceBetween>
  );
}
