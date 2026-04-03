/**
 * Dashboard Page
 *
 * 参加者ダッシュボード
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '../../components/layout';
import { useI18n } from '../../lib/i18n';
import { getAvailableEvents, getMyEvents } from '../../lib/api/events';
import type { ParticipantEvent } from '../../lib/api/types';

function getProblemTypeColor(type: string): 'blue' | 'green' {
  return type === 'gameday' ? 'blue' : 'green';
}

function getProblemTypeLabel(type: string) {
  return type === 'gameday' ? 'GameDay' : 'JAM';
}

function getStatusType(status: string): 'success' | 'warning' | 'info' {
  if (status === 'active') return 'success';
  if (status === 'scheduled') return 'warning';
  return 'info';
}

function getStatusLabel(status: string, t: (key: string) => string) {
  if (status === 'active') return t('dashboard.activeStatus');
  if (status === 'scheduled') return t('dashboard.scheduledStatus');
  return status;
}

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const [myEvents, setMyEvents] = useState<ParticipantEvent[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [myEventsRes, upcomingRes] = await Promise.all([
          getMyEvents(),
          getAvailableEvents({ status: ['scheduled', 'active'], limit: 5 }),
        ]);
        setMyEvents(myEventsRes.events);
        setUpcomingEvents(
          upcomingRes.events.filter(
            (e) => !myEventsRes.events.some((me) => me.id === e.id),
          ),
        );
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました'),
        );
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const activeEvents = myEvents.filter((e) => e.status === 'active');
  const scheduledEvents = myEvents.filter((e) => e.status === 'scheduled');

  return (
    <div className="min-h-screen">
      <AppHeader />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <SpaceBetween size="xl">
          <Header variant="h1" description={t('dashboard.description')}>
            {t('dashboard.title')}
          </Header>

          {loading ? (
            <Box textAlign="center" padding="xxl">
              <Spinner size="large" />
            </Box>
          ) : error ? (
            <Box textAlign="center" padding="xl">
              <SpaceBetween size="m">
                <StatusIndicator type="error">{error.message}</StatusIndicator>
                <Button onClick={() => window.location.reload()}>
                  {t('common.retry')}
                </Button>
              </SpaceBetween>
            </Box>
          ) : (
            <SpaceBetween size="xl">
              {activeEvents.length > 0 ? (
                <Container
                  header={<Header variant="h2">{t('dashboard.active')}</Header>}
                >
                  <Cards
                    cardDefinition={{
                      header: (event) => (
                        <Link href={`/events/${event.id}`}>{event.name}</Link>
                      ),
                      sections: [
                        {
                          id: 'meta',
                          header: t('dashboard.type'),
                          content: (event) => (
                            <SpaceBetween direction="horizontal" size="xs">
                              <Badge color={getProblemTypeColor(event.type)}>
                                {getProblemTypeLabel(event.type)}
                              </Badge>
                              <StatusIndicator
                                type={getStatusType(event.status)}
                              >
                                {getStatusLabel(event.status, t)}
                              </StatusIndicator>
                            </SpaceBetween>
                          ),
                        },
                        {
                          id: 'schedule',
                          header: t('dashboard.end'),
                          content: (event) => formatDate(event.endTime),
                        },
                        {
                          id: 'stats',
                          header: t('dashboard.status'),
                          content: (event) =>
                            `${t('dashboard.problems')}: ${event.problemCount} / ${t('dashboard.participants')}: ${event.participantCount}`,
                        },
                        {
                          id: 'rank',
                          header: t('dashboard.rank'),
                          content: (event) =>
                            event.myRank
                              ? `#${event.myRank} / ${event.myScore} pts`
                              : t('dashboard.notJoined'),
                        },
                        {
                          id: 'action',
                          header: t('gameday.action'),
                          content: (event) => (
                            <Link href={`/events/${event.id}`}>
                              <Button variant="primary" fullWidth>
                                {t('dashboard.join')}
                              </Button>
                            </Link>
                          ),
                        },
                      ],
                    }}
                    cardsPerRow={[{ cards: 1 }, { minWidth: 480, cards: 2 }]}
                    items={activeEvents}
                    loadingText={t('common.loading')}
                  />
                </Container>
              ) : null}

              {scheduledEvents.length > 0 ? (
                <Container
                  header={
                    <Header variant="h2">{t('dashboard.scheduled')}</Header>
                  }
                >
                  <Cards
                    cardDefinition={{
                      header: (event) => (
                        <Link href={`/events/${event.id}`}>{event.name}</Link>
                      ),
                      sections: [
                        {
                          id: 'meta',
                          header: t('dashboard.type'),
                          content: (event) => (
                            <SpaceBetween direction="horizontal" size="xs">
                              <Badge color={getProblemTypeColor(event.type)}>
                                {getProblemTypeLabel(event.type)}
                              </Badge>
                              <StatusIndicator
                                type={getStatusType(event.status)}
                              >
                                {getStatusLabel(event.status, t)}
                              </StatusIndicator>
                            </SpaceBetween>
                          ),
                        },
                        {
                          id: 'schedule',
                          header: t('dashboard.start'),
                          content: (event) => formatDate(event.startTime),
                        },
                      ],
                    }}
                    cardsPerRow={[
                      { cards: 1 },
                      { minWidth: 320, cards: 2 },
                      { minWidth: 960, cards: 3 },
                    ]}
                    items={scheduledEvents}
                    loadingText={t('common.loading')}
                  />
                </Container>
              ) : null}

              {upcomingEvents.length > 0 ? (
                <Container
                  header={
                    <Header
                      variant="h2"
                      actions={
                        <Link href="/events">
                          <Button variant="link">
                            {t('dashboard.viewAll')}
                          </Button>
                        </Link>
                      }
                    >
                      {t('dashboard.upcoming')}
                    </Header>
                  }
                >
                  <Cards
                    cardDefinition={{
                      header: (event) => (
                        <Link href={`/events/${event.id}`}>{event.name}</Link>
                      ),
                      sections: [
                        {
                          id: 'meta',
                          header: t('dashboard.type'),
                          content: (event) => (
                            <SpaceBetween direction="horizontal" size="xs">
                              <Badge color={getProblemTypeColor(event.type)}>
                                {getProblemTypeLabel(event.type)}
                              </Badge>
                              <Box color="text-body-secondary">
                                {event.participantCount}{' '}
                                {t('dashboard.registeredCount')}
                              </Box>
                            </SpaceBetween>
                          ),
                        },
                        {
                          id: 'schedule',
                          header: t('dashboard.start'),
                          content: (event) => formatDate(event.startTime),
                        },
                        {
                          id: 'action',
                          header: t('gameday.action'),
                          content: (event) => (
                            <Link href={`/events/${event.id}`}>
                              <Button variant="normal" fullWidth>
                                {t('dashboard.details')}
                              </Button>
                            </Link>
                          ),
                        },
                      ],
                    }}
                    cardsPerRow={[
                      { cards: 1 },
                      { minWidth: 320, cards: 2 },
                      { minWidth: 960, cards: 3 },
                    ]}
                    items={upcomingEvents}
                    loadingText={t('common.loading')}
                  />
                </Container>
              ) : null}

              {myEvents.length === 0 && upcomingEvents.length === 0 ? (
                <Container>
                  <Box textAlign="center" padding="xxl">
                    <SpaceBetween size="m">
                      <Box fontSize="display-l">🏆</Box>
                      <Header variant="h2">{t('dashboard.noEvents')}</Header>
                      <Box color="text-body-secondary">
                        {t('dashboard.noEventsDescription')}
                      </Box>
                      <Link href="/events">
                        <Button variant="primary">
                          {t('dashboard.eventsList')}
                        </Button>
                      </Link>
                    </SpaceBetween>
                  </Box>
                </Container>
              ) : null}
            </SpaceBetween>
          )}
        </SpaceBetween>
      </main>
    </div>
  );
}
