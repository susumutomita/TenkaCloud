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
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import { PageLayout } from '../../components/layout';
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

const getRankIcon = (rank: number) => {
  switch (rank) {
    case 1:
      return '\u{1F947}';
    case 2:
      return '\u{1F948}';
    case 3:
      return '\u{1F949}';
    default:
      return `#${rank}`;
  }
};

const getRankColor = (rank: number) => {
  switch (rank) {
    case 1:
      return 'linear-gradient(135deg, #FFD700, #FFA500)';
    case 2:
      return 'linear-gradient(135deg, #C0C0C0, #A0A0A0)';
    case 3:
      return 'linear-gradient(135deg, #CD7F32, #A0522D)';
    default:
      return 'linear-gradient(135deg, #6B7280, #4B5563)';
  }
};

const getRankBoxColor = (rank: number) => {
  switch (rank) {
    case 1:
      return '#FFF8E1';
    case 2:
      return '#F5F5F5';
    case 3:
      return '#FBE9E7';
    default:
      return undefined;
  }
};

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

  return (
    <PageLayout>
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
              <Button onClick={fetchRankings}>再試行</Button>
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
                  <Box variant="p" fontSize="heading-xl" fontWeight="bold">
                    {'\u{1F3C6}'}
                  </Box>
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
                cell: (item) => {
                  const bgColor = getRankBoxColor(item.rank);
                  return (
                    <Box
                      fontSize={item.rank <= 3 ? 'heading-m' : 'body-m'}
                      fontWeight="bold"
                    >
                      {bgColor ? (
                        <span
                          style={{
                            background: bgColor,
                            padding: '4px 12px',
                            borderRadius: '8px',
                            display: 'inline-block',
                          }}
                        >
                          {getRankIcon(item.rank)}
                        </span>
                      ) : (
                        getRankIcon(item.rank)
                      )}
                    </Box>
                  );
                },
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
                        background: getRankColor(item.rank),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: '0.875rem',
                        color: '#FFFFFF',
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
                cell: (item) => (
                  <Badge color="blue">{`${item.eventsParticipated}回`}</Badge>
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
    </PageLayout>
  );
}
