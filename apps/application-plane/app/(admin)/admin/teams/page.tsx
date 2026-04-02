/**
 * Admin Teams Page
 *
 * Cloudscape Design System
 * チーム管理
 */

'use client';

import { useEffect, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Input from '@cloudscape-design/components/input';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Button from '@cloudscape-design/components/button';
import '@cloudscape-design/global-styles/index.css';
import type { AdminTeam } from '@/lib/api/admin-types';
import { formatDate } from '@/lib/utils';

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTeams() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (searchQuery) params.set('search', searchQuery);

        const response = await fetch(`/api/admin/teams?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `チームの取得に失敗しました (${response.status})`,
          );
        }

        const data = await response.json();
        setTeams(data.teams || []);
      } catch (err) {
        console.error('Failed to fetch teams:', err);
        setError(
          err instanceof Error ? err.message : 'チームの取得に失敗しました',
        );
        setTeams([]);
      } finally {
        setLoading(false);
      }
    }

    // デバウンス用のタイマー
    const timeoutId = setTimeout(fetchTeams, searchQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // API がフィルタリングするため、クライアント側ではそのまま使用
  const filteredTeams = teams;

  const totalMembers = teams.reduce((acc, t) => acc + t.memberCount, 0);
  const avgScore =
    teams.length > 0
      ? Math.round(
          teams.reduce((acc, t) => acc + t.totalScore, 0) / teams.length,
        )
      : 0;

  return (
    <SpaceBetween size="l">
      <Header variant="h1">チーム管理</Header>

      <Input
        type="search"
        value={searchQuery}
        onChange={({ detail }) => setSearchQuery(detail.value)}
        placeholder="チーム名で検索..."
      />

      <ColumnLayout columns={3}>
        <Container>
          <Box variant="awsui-key-label">総チーム数</Box>
          <Box variant="awsui-value-large">{teams.length}</Box>
        </Container>
        <Container>
          <Box variant="awsui-key-label">総メンバー数</Box>
          <Box variant="awsui-value-large">{totalMembers}</Box>
        </Container>
        <Container>
          <Box variant="awsui-key-label">平均チームスコア</Box>
          <Box variant="awsui-value-large">{avgScore}</Box>
        </Container>
      </ColumnLayout>

      {error ? (
        <Container>
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m" direction="vertical" alignItems="center">
              <StatusIndicator type="error">
                エラーが発生しました
              </StatusIndicator>
              <Box variant="p" color="text-body-secondary">
                {error}
              </Box>
              <Button onClick={() => setSearchQuery('')}>再読み込み</Button>
            </SpaceBetween>
          </Box>
        </Container>
      ) : (
        <Cards
          loading={loading}
          loadingText="チームを読み込み中..."
          items={filteredTeams}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 400, cards: 2 },
            { minWidth: 700, cards: 3 },
          ]}
          trackBy="id"
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="s">
                <Box variant="h3">チームが見つかりません</Box>
                <Box variant="p" color="text-body-secondary">
                  {searchQuery
                    ? '検索条件を変更してください。'
                    : '参加者がチームを作成するとここに表示されます。'}
                </Box>
              </SpaceBetween>
            </Box>
          }
          cardDefinition={{
            header: (team) => team.name,
            sections: [
              {
                id: 'invite-code',
                header: '招待コード',
                content: (team) => (
                  <Box fontWeight="bold" variant="code">
                    {team.inviteCode ?? '-'}
                  </Box>
                ),
              },
              {
                id: 'score',
                header: 'スコア',
                content: (team) => (
                  <Box fontSize="heading-l" fontWeight="bold">
                    {team.totalScore.toLocaleString()}{' '}
                    <Box variant="small" display="inline">
                      pts
                    </Box>
                  </Box>
                ),
              },
              {
                id: 'members',
                header: 'メンバー',
                content: (team) => (
                  <ProgressBar
                    value={(team.memberCount / team.maxMembers) * 100}
                    additionalInfo={`${team.memberCount} / ${team.maxMembers}`}
                  />
                ),
              },
              {
                id: 'events',
                header: '参加イベント',
                content: (team) => team.eventsCount,
              },
              {
                id: 'created',
                header: '作成日',
                content: (team) => formatDate(team.createdAt),
              },
            ],
          }}
        />
      )}
    </SpaceBetween>
  );
}
