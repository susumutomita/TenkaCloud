/**
 * Rankings Page
 *
 * グローバルランキングページ
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

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return '🥇';
      case 2:
        return '🥈';
      case 3:
        return '🥉';
      default:
        return `#${rank}`;
    }
  };

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            {/* Page Header */}
            <div>
              <h1
                style={{
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  margin: 0,
                  color: 'var(--color-text-heading-default)',
                }}
              >
                ランキング
              </h1>
              <Box variant="p" color="text-body-secondary">
                クラウドエンジニアの頂点を目指せ
              </Box>
            </div>

            {/* My Rank Banner */}
            {data?.myRank && (
              <Container>
                <StatusIndicator type="info">
                  あなたの現在の順位:{' '}
                  <Box variant="span" fontWeight="bold" fontSize="heading-m">
                    {data.myRank}位
                  </Box>{' '}
                  / {data.total}人中
                </StatusIndicator>
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
                    <Spinner size="large" />
                  ) : (
                    <Box variant="p" fontSize="heading-xl" fontWeight="bold">
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
                    <Spinner size="large" />
                  ) : (
                    <Box variant="p" fontSize="heading-xl" fontWeight="bold">
                      {topScore !== undefined ? topScore.toLocaleString() : '-'}
                    </Box>
                  )}
                </Container>
              </ColumnLayout>
            )}

            {/* Error State */}
            {error && (
              <Container>
                <SpaceBetween size="m" direction="vertical" alignItems="center">
                  <StatusIndicator type="error">
                    {getErrorMessage(error)}
                  </StatusIndicator>
                  <Button onClick={fetchRankings}>再試行</Button>
                </SpaceBetween>
              </Container>
            )}

            {/* Rankings Table */}
            {!error && (
              <Table
                header={
                  <CloudscapeHeader
                    counter={`(${rankings.length})`}
                    actions={<Badge color="blue">Top 50</Badge>}
                  >
                    ランキング
                  </CloudscapeHeader>
                }
                loading={loading}
                loadingText="ランキングを読み込み中..."
                items={rankings}
                empty={
                  <Box textAlign="center" padding="xl">
                    <SpaceBetween size="s">
                      <Box variant="h2" fontWeight="bold">
                        ランキングデータがありません
                      </Box>
                      <Box variant="p" color="text-body-secondary">
                        イベントに参加してランキングに載ろう！
                      </Box>
                    </SpaceBetween>
                  </Box>
                }
                columnDefinitions={[
                  {
                    id: 'rank',
                    header: '順位',
                    width: 100,
                    cell: (item) => (
                      <Box
                        fontSize={item.rank <= 3 ? 'heading-m' : 'body-m'}
                        fontWeight="bold"
                      >
                        {getRankIcon(item.rank)}
                      </Box>
                    ),
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
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: 'var(--color-background-badge-icon)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                            fontSize: '0.875rem',
                          }}
                        >
                          {item.name.charAt(0)}
                        </div>
                        <Box fontWeight="bold">{item.name}</Box>
                      </SpaceBetween>
                    ),
                  },
                  {
                    id: 'eventsParticipated',
                    header: '参加イベント',
                    width: 150,
                    cell: (item) => item.eventsParticipated,
                  },
                  {
                    id: 'totalScore',
                    header: '合計スコア',
                    width: 180,
                    cell: (item) => (
                      <Box fontWeight="bold" fontSize="heading-s">
                        {item.totalScore.toLocaleString()}
                        <Box variant="span" color="text-body-secondary">
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
