/**
 * Leaderboard Page
 *
 * Cloudscape Design System — イベントリーダーボードページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '../../../../components/layout';
import { useI18n } from '../../../../lib/i18n';
import { getEventDetails, getLeaderboard } from '../../../../lib/api/events';
import type {
  EventDetails,
  Leaderboard,
  LeaderboardEntry,
} from '../../../../lib/api/types';

export default function LeaderboardPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [eventData, leaderboardData] = await Promise.all([
          getEventDetails(eventId),
          getLeaderboard(eventId),
        ]);
        setEvent(eventData);
        setLeaderboard(leaderboardData);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(t('common.loading')));
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [eventId]);

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <Box textAlign="center" padding="xl">
          <Spinner size="large" />
        </Box>
      </div>
    );
  }

  if (error || !leaderboard) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="awsui-dark-mode">
            <Container>
              <SpaceBetween size="m">
                <StatusIndicator type="error">
                  {error?.message ?? t('common.loading')}
                </StatusIndicator>
                <Button onClick={() => router.push(`/events/${eventId}`)}>
                  {t('leaderboard.backToEvent')}
                </Button>
              </SpaceBetween>
            </Container>
          </div>
        </main>
      </div>
    );
  }

  const problemIds = event?.problems.map((p) => p.id) ?? [];

  const columnDefinitions = [
    {
      id: 'rank',
      header: t('leaderboard.rank'),
      cell: (entry: LeaderboardEntry) => {
        const icons: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
        return icons[entry.rank] ?? `#${entry.rank}`;
      },
      width: 80,
    },
    {
      id: 'name',
      header: t('leaderboard.name'),
      cell: (entry: LeaderboardEntry) => (
        <SpaceBetween direction="horizontal" size="xs">
          <Box variant="span" fontWeight={entry.isMe ? 'bold' : 'normal'}>
            {entry.name}
          </Box>
          {entry.isMe && <Badge color="blue">{t('battles.me')}</Badge>}
        </SpaceBetween>
      ),
    },
    ...problemIds.map((pid, i) => ({
      id: `p-${pid}`,
      header: `Q${i + 1}`,
      cell: (entry: LeaderboardEntry) => {
        const score = entry.problemScores[pid];
        return score !== undefined ? (
          <Box
            color={score > 0 ? 'text-status-success' : 'text-body-secondary'}
          >
            {score}
          </Box>
        ) : (
          <Box color="text-body-secondary">-</Box>
        );
      },
      width: 70,
    })),
    {
      id: 'total',
      header: t('leaderboard.total'),
      cell: (entry: LeaderboardEntry) => (
        <Box fontWeight="bold">{entry.totalScore}</Box>
      ),
      width: 90,
    },
    {
      id: 'trend',
      header: t('leaderboard.trend'),
      cell: (entry: LeaderboardEntry) => {
        if (entry.trend === 'up')
          return <Box color="text-status-success">↑</Box>;
        if (entry.trend === 'down')
          return <Box color="text-status-error">↓</Box>;
        return <Box color="text-body-secondary">—</Box>;
      },
      width: 60,
    },
  ];

  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            <BreadcrumbGroup
              items={[
                { text: t('events.title'), href: '/events' },
                {
                  text: event?.name ?? eventId,
                  href: `/events/${eventId}`,
                },
                { text: t('leaderboard.title'), href: '#' },
              ]}
              onFollow={(e) => {
                e.preventDefault();
                if (e.detail.href !== '#') router.push(e.detail.href);
              }}
            />

            {leaderboard.myPosition && (
              <Container>
                <SpaceBetween direction="horizontal" size="l">
                  <Box
                    fontSize="heading-xl"
                    fontWeight="bold"
                    color="text-status-info"
                  >
                    #{leaderboard.myPosition}
                  </Box>
                  <Box variant="span">{t('leaderboard.myPosition')}</Box>
                  <Box fontWeight="bold">
                    {leaderboard.entries.find((e) => e.isMe)?.totalScore ?? 0}{' '}
                    pts
                  </Box>
                </SpaceBetween>
              </Container>
            )}

            <Table
              columnDefinitions={columnDefinitions}
              items={leaderboard.entries}
              loading={false}
              header={
                <Header
                  counter={`(${leaderboard.entries.length})`}
                  description={`${t('leaderboard.lastUpdated')} ${formatTime(leaderboard.updatedAt)}`}
                  actions={
                    leaderboard.isFrozen ? (
                      <Badge color="severity-medium">
                        {t('leaderboard.frozen')}
                      </Badge>
                    ) : undefined
                  }
                >
                  {t('leaderboard.title')}
                </Header>
              }
              empty={
                <Box textAlign="center" color="inherit" padding="xl">
                  <SpaceBetween size="m">
                    <Box fontSize="heading-xl">📊</Box>
                    <b>{t('leaderboard.noResults')}</b>
                    <Box variant="p" color="inherit">
                      {t('leaderboard.noResultsDescription')}
                    </Box>
                  </SpaceBetween>
                </Box>
              }
            />
          </SpaceBetween>
        </div>
      </main>
    </div>
  );
}
