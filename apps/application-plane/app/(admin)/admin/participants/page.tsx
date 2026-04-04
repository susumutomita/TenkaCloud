/**
 * Admin Participants Page
 *
 * Cloudscape Design System
 * 参加者管理
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useEffect, useState } from 'react';

import type { AdminParticipant } from '@/lib/api/admin-types';
import { formatDate } from '@/lib/utils';

const STATUS_MAP: Record<
  string,
  { type: 'success' | 'warning' | 'error'; label: string }
> = {
  active: { type: 'success', label: 'アクティブ' },
  inactive: { type: 'warning', label: '非アクティブ' },
  banned: { type: 'error', label: '禁止' },
};

export default function AdminParticipantsPage() {
  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchParticipants() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (searchQuery) params.set('search', searchQuery);

        const response = await fetch(
          `/api/admin/participants?${params.toString()}`,
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `参加者の取得に失敗しました (${response.status})`,
          );
        }

        const data = await response.json();
        setParticipants(data.participants || []);
      } catch (err) {
        console.error('Failed to fetch participants:', err);
        setError(
          err instanceof Error ? err.message : '参加者の取得に失敗しました',
        );
        setParticipants([]);
      } finally {
        setLoading(false);
      }
    }

    // デバウンス用のタイマー
    const timeoutId = setTimeout(fetchParticipants, searchQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // API がフィルタリングするため、クライアント側ではそのまま使用
  const filteredParticipants = participants;

  const activeCount = participants.filter((p) => p.status === 'active').length;
  const avgScore =
    participants.length > 0
      ? Math.round(
          participants.reduce((acc, p) => acc + (p.totalScore || 0), 0) /
            participants.length,
        )
      : 0;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Button variant="primary" iconName="add-plus">
            参加者を招待
          </Button>
        }
      >
        参加者管理
      </Header>

      <Input
        type="search"
        placeholder="名前またはメールアドレスで検索..."
        value={searchQuery}
        onChange={({ detail }) => setSearchQuery(detail.value)}
      />

      {/* Stats */}
      <ColumnLayout columns={3}>
        <Container>
          <Box variant="awsui-key-label">総参加者数</Box>
          <Box variant="awsui-value-large">{participants.length}</Box>
        </Container>
        <Container>
          <Box variant="awsui-key-label">アクティブユーザー</Box>
          <Box variant="awsui-value-large" color="text-status-success">
            {activeCount}
          </Box>
        </Container>
        <Container>
          <Box variant="awsui-key-label">平均スコア</Box>
          <Box variant="awsui-value-large">{avgScore}</Box>
        </Container>
      </ColumnLayout>

      {/* Error State */}
      {error && (
        <Container>
          <Box textAlign="center" padding="l">
            <SpaceBetween size="s" alignItems="center">
              <Box variant="h2" color="text-status-error">
                エラーが発生しました
              </Box>
              <Box color="text-body-secondary">{error}</Box>
              <Button onClick={() => setSearchQuery('')}>再読み込み</Button>
            </SpaceBetween>
          </Box>
        </Container>
      )}

      {/* Participants Table */}
      {!error && (
        <Table
          loading={loading}
          loadingText="参加者を読み込み中..."
          items={filteredParticipants}
          columnDefinitions={[
            {
              id: 'name',
              header: '名前',
              cell: (item) => <Box fontWeight="bold">{item.displayName}</Box>,
              sortingField: 'displayName',
            },
            {
              id: 'email',
              header: 'メール',
              cell: (item) => item.email,
              sortingField: 'email',
            },
            {
              id: 'status',
              header: 'ステータス',
              cell: (item) => {
                const status = STATUS_MAP[item.status] ?? {
                  type: 'warning' as const,
                  label: item.status,
                };
                return (
                  <StatusIndicator type={status.type}>
                    {status.label}
                  </StatusIndicator>
                );
              },
              sortingField: 'status',
            },
            {
              id: 'role',
              header: 'ロール',
              cell: (item) =>
                item.role === 'admin' ? (
                  <Badge color="blue">管理者</Badge>
                ) : (
                  <Box color="text-body-secondary">参加者</Box>
                ),
              sortingField: 'role',
            },
            {
              id: 'eventsCount',
              header: 'イベント数',
              cell: (item) => item.eventsCount ?? 0,
              sortingField: 'eventsCount',
            },
            {
              id: 'totalScore',
              header: 'スコア',
              cell: (item) => (item.totalScore ?? 0).toLocaleString(),
              sortingField: 'totalScore',
            },
            {
              id: 'joinedAt',
              header: '登録日',
              cell: (item) => formatDate(item.joinedAt),
              sortingField: 'joinedAt',
            },
            {
              id: 'actions',
              header: 'アクション',
              cell: () => <Button variant="inline-link">詳細</Button>,
            },
          ]}
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="s" alignItems="center">
                <Box variant="h3" fontWeight="bold">
                  参加者が見つかりません
                </Box>
                <Box color="text-body-secondary">
                  {searchQuery
                    ? '検索条件を変更してください。'
                    : '参加者を招待して始めましょう。'}
                </Box>
                <Button variant="primary" iconName="add-plus">
                  参加者を招待
                </Button>
              </SpaceBetween>
            </Box>
          }
          header={
            <Header counter={`(${filteredParticipants.length})`}>
              参加者一覧
            </Header>
          }
        />
      )}
    </SpaceBetween>
  );
}
