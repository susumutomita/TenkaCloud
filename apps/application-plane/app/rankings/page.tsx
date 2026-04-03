/**
 * Rankings Page
 *
 * Cloudscape Design System — グローバルランキングページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import CloudscapeHeader from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import { Header } from '../../components/layout';
import { getErrorMessage } from '../../components/ui';
import { getGlobalRanking } from '../../lib/api/profile';

interface RankingEntry {
  rank: number;
  participantId: string;
  name: string;
  totalScore: number;
  eventsParticipated: number;
}

interface RankingData {
  rankings: RankingEntry[];
  total: number;
  myRank?: number;
}

export default function RankingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<RankingData | null>(null);

  const fetchRankings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getGlobalRanking({ limit: 50 });
      setData({
        rankings: res.rankings.map((r) => ({
          rank: r.rank,
          participantId: r.userId,
          name: r.name,
          totalScore: r.totalScore,
          eventsParticipated: r.eventsParticipated,
        })),
        total: res.total,
        myRank: res.myRank,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRankings();
  }, [fetchRankings]);

  const rankings = data?.rankings ?? [];
  const totalParticipants = data?.total ?? 0;
  const topScore = rankings[0]?.totalScore;

  const getRankDisplay = (rank: number) => {
    switch (rank) {
      case 1:
        return (
          <Box
            fontSize="heading-l"
            fontWeight="heavy"
            color="text-status-warning"
          >
            🥇 1st
          </Box>
        );
      case 2:
        return (
          <Box fontSize="heading-m" fontWeight="bold">
            🥈 2nd
          </Box>
        );
      case 3:
        return (
          <Box fontSize="heading-m" fontWeight="bold" color="text-status-info">
            🥉 3rd
          </Box>
        );
      default:
        return (
          <Box fontWeight="bold" color="text-body-secondary">
            #{rank}
          </Box>
        );
    }
  };

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            {/* My Rank Banner */}
            {data?.myRank && (
              <Container>
                <SpaceBetween
                  direction="horizontal"
                  size="m"
                  alignItems="center"
                >
                  <Box
                    fontSize="display-l"
                    fontWeight="heavy"
                    color="text-status-info"
                  >
                    {data.myRank}位
                  </Box>
                  <SpaceBetween size="xxs">
                    <Box fontWeight="bold">あなたの現在の順位:</Box>
                    <Box color="text-body-secondary">/ {data.total}人中</Box>
                  </SpaceBetween>
                </SpaceBetween>
              </Container>
            )}

            {/* Stats Cards */}
            {!error && (
              <ColumnLayout columns={2}>
                <Container
                  header={
                    <CloudscapeHeader variant="h3">総参加者数</CloudscapeHeader>
                  }
                >
                  {loading ? (
                    <Box padding="s">
                      <Spinner size="large" />
                    </Box>
                  ) : (
                    <Box fontSize="display-l" fontWeight="heavy">
                      {totalParticipants.toLocaleString()}
                    </Box>
                  )}
                </Container>

                <Container
                  header={
                    <CloudscapeHeader variant="h3">最高スコア</CloudscapeHeader>
                  }
                >
                  {loading ? (
                    <Box padding="s">
                      <Spinner size="large" />
                    </Box>
                  ) : (
                    <Box fontSize="display-l" fontWeight="heavy">
                      {topScore !== undefined ? topScore.toLocaleString() : '-'}
                    </Box>
                  )}
                </Container>
              </ColumnLayout>
            )}

            {/* Error State */}
            {error && (
              <Container>
                <Box textAlign="center" padding="xxl">
                  <SpaceBetween size="l" alignItems="center">
                    <Box fontSize="display-l">⚠️</Box>
                    <StatusIndicator type="error">
                      {getErrorMessage(error)}
                    </StatusIndicator>
                    <Button variant="primary" onClick={fetchRankings}>
                      再試行
                    </Button>
                  </SpaceBetween>
                </Box>
              </Container>
            )}

            {/* Rankings Table */}
            {!error && (
              <Table
                variant="container"
                header={
                  <CloudscapeHeader
                    variant="h1"
                    counter={!loading ? `(${rankings.length})` : undefined}
                    description="クラウドエンジニアの頂点を目指せ"
                    actions={<Badge color="blue">Top 50</Badge>}
                  >
                    ランキング
                  </CloudscapeHeader>
                }
                loading={loading}
                loadingText="ランキングを読み込み中..."
                items={rankings}
                empty={
                  <Box textAlign="center" padding="xxl">
                    <SpaceBetween size="l" alignItems="center">
                      <Box fontSize="display-l">🏆</Box>
                      <Box variant="h2" fontWeight="bold">
                        ランキングデータがありません
                      </Box>
                      <Box variant="p" color="text-body-secondary">
                        イベントに参加してランキングに載ろう！
                      </Box>
                      <Button variant="primary" href="/events">
                        イベントを探す
                      </Button>
                    </SpaceBetween>
                  </Box>
                }
                columnDefinitions={[
                  {
                    id: 'rank',
                    header: '順位',
                    width: 120,
                    cell: (item) => getRankDisplay(item.rank),
                  },
                  {
                    id: 'name',
                    header: '名前',
                    cell: (item) => (
                      <SpaceBetween
                        size="xs"
                        direction="horizontal"
                        alignItems="center"
                      >
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: '50%',
                            background:
                              item.rank === 1
                                ? 'linear-gradient(135deg, #f0c674, #e0a030)'
                                : item.rank === 2
                                  ? 'linear-gradient(135deg, #c0c0c0, #a0a0a0)'
                                  : item.rank === 3
                                    ? 'linear-gradient(135deg, #cd7f32, #b06820)'
                                    : 'var(--color-background-badge-icon, #414d5c)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                            fontSize: '0.875rem',
                            color: '#fff',
                          }}
                        >
                          {item.name.charAt(0).toUpperCase()}
                        </div>
                        <Box fontWeight="bold" fontSize="heading-s">
                          {item.name}
                        </Box>
                      </SpaceBetween>
                    ),
                  },
                  {
                    id: 'eventsParticipated',
                    header: '参加イベント',
                    width: 150,
                    cell: (item) => (
                      <Badge color="blue">{`${item.eventsParticipated}`}</Badge>
                    ),
                  },
                  {
                    id: 'totalScore',
                    header: '合計スコア',
                    width: 200,
                    cell: (item) => (
                      <Box fontWeight="bold" fontSize="heading-m">
                        {item.totalScore.toLocaleString()}
                        <Box
                          variant="span"
                          color="text-body-secondary"
                          fontSize="body-s"
                        >
                          {' '}
                          pts
                        </Box>
                      </Box>
                    ),
                  },
                ]}
              />
            )}
          </SpaceBetween>
        </div>
      </main>
    </div>
  );
}
