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
import Link from '@cloudscape-design/components/link';
import Pagination from '@cloudscape-design/components/pagination';
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

const getRankLabel = (rank: number) => {
  switch (rank) {
    case 1:
      return '1st';
    case 2:
      return '2nd';
    case 3:
      return '3rd';
    default:
      return `${rank}`;
  }
};

const PAGE_SIZE = 20;

export default function RankingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<RankingData | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const fetchRankings = useCallback(async (page: number) => {
    try {
      setLoading(true);
      setError(null);
      const offset = (page - 1) * PAGE_SIZE;
      const res = await getGlobalRanking({ limit: PAGE_SIZE, offset });
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
    fetchRankings(currentPage);
  }, [fetchRankings, currentPage]);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const rankings = data?.rankings ?? [];
  const totalParticipants = data?.total ?? 0;
  const topScore = rankings[0]?.totalScore;

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            {/* My Rank Banner */}
            {data?.myRank && (
              <Container>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                  }}
                >
                  <Box fontSize="display-l" fontWeight="heavy">
                    {data.myRank}位
                  </Box>
                  <div>
                    <Box variant="p" color="text-body-secondary">
                      あなたの現在の順位
                    </Box>
                    <Box variant="p" color="text-body-secondary">
                      / {data.total}人中
                    </Box>
                  </div>
                </div>
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
                    <Box variant="p" fontSize="display-l" fontWeight="heavy">
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
                    <Box variant="p" fontSize="display-l" fontWeight="heavy">
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
                  <Button onClick={() => fetchRankings(currentPage)}>
                    再試行
                  </Button>
                </SpaceBetween>
              </Container>
            )}

            {/* Rankings Table */}
            {!error && (
              <Table
                header={
                  <CloudscapeHeader
                    variant="h1"
                    description="クラウドエンジニアの頂点を目指せ"
                    counter={`(${totalParticipants})`}
                  >
                    ランキング
                  </CloudscapeHeader>
                }
                loading={loading}
                loadingText="ランキングを読み込み中..."
                items={rankings}
                pagination={
                  totalParticipants > PAGE_SIZE ? (
                    <Pagination
                      currentPageIndex={currentPage}
                      pagesCount={Math.ceil(totalParticipants / PAGE_SIZE)}
                      onChange={({ detail }) =>
                        handlePageChange(detail.currentPageIndex)
                      }
                    />
                  ) : undefined
                }
                empty={
                  <Box textAlign="center" padding="xl">
                    <SpaceBetween size="s">
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
                    width: 100,
                    cell: (item) => (
                      <Box
                        fontSize={item.rank <= 3 ? 'heading-m' : 'body-m'}
                        fontWeight="bold"
                      >
                        {getRankLabel(item.rank)}
                      </Box>
                    ),
                  },
                  {
                    id: 'name',
                    header: '名前',
                    cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
                  },
                  {
                    id: 'eventsParticipated',
                    header: '参加イベント',
                    width: 150,
                    cell: (item) => (
                      <Badge color="blue">
                        {`${item.eventsParticipated}回`}
                      </Badge>
                    ),
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
