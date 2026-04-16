/**
 * Dashboard Page
 *
 * 参加者ダッシュボード — マイイベント（参加中・登録済み）の個人ビュー
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageLayout } from '../../components/layout';
import { useI18n } from '../../lib/i18n';
import { getMyEvents } from '../../lib/api/events';
import type { ParticipantEvent } from '../../lib/api/types';

function getStatusIndicator(status: string, t: (k: string) => string) {
  if (status === 'active')
    return (
      <StatusIndicator type="success">
        {t('dashboard.activeStatus')}
      </StatusIndicator>
    );
  if (status === 'scheduled')
    return (
      <StatusIndicator type="pending">
        {t('dashboard.scheduledStatus')}
      </StatusIndicator>
    );
  return <StatusIndicator type="info">{status}</StatusIndicator>;
}

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [myEvents, setMyEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    getMyEvents()
      .then((res) => setMyEvents(res.events))
      .catch(() => setError(new Error(t('dashboard.loadError'))))
      .finally(() => setLoading(false));
  }, [t]);

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString(
      locale === 'ja' ? 'ja-JP' : 'en-US',
      {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      },
    );

  const activeEvents = myEvents.filter((e) => e.status === 'active');
  const scheduledEvents = myEvents.filter((e) => e.status === 'scheduled');

  const cardDefinitionActive = {
    header: (event: ParticipantEvent) => (
      <Link
        href={`/events/${event.id}`}
        fontSize="heading-m"
        onFollow={(e) => {
          e.preventDefault();
          router.push(`/events/${event.id}`);
        }}
      >
        {event.name}
      </Link>
    ),
    sections: [
      {
        id: 'meta',
        header: t('dashboard.type'),
        content: (event: ParticipantEvent) => (
          <SpaceBetween direction="horizontal" size="xs">
            <Badge color={event.type === 'gameday' ? 'blue' : 'green'}>
              {event.type === 'gameday' ? 'Incident Drill' : 'Challenge'}
            </Badge>
            {getStatusIndicator(event.status, t)}
          </SpaceBetween>
        ),
      },
      {
        id: 'end',
        header: t('dashboard.end'),
        content: (event: ParticipantEvent) => formatDate(event.endTime),
      },
      {
        id: 'stats',
        header: t('dashboard.status'),
        content: (event: ParticipantEvent) =>
          `${t('dashboard.problems')}: ${event.problemCount ?? 0} / ${t('dashboard.participants')}: ${event.participantCount ?? 0}`,
      },
      {
        id: 'rank',
        header: t('dashboard.rank'),
        content: (event: ParticipantEvent) =>
          event.myRank
            ? `#${event.myRank} / ${event.myScore ?? 0} pts`
            : t('dashboard.notJoined'),
      },
      {
        id: 'action',
        content: (event: ParticipantEvent) => (
          <Button
            variant="primary"
            fullWidth
            onClick={() => router.push(`/events/${event.id}`)}
          >
            {t('dashboard.join')}
          </Button>
        ),
      },
    ],
  };

  const cardDefinitionScheduled = {
    header: (event: ParticipantEvent) => (
      <Link
        href={`/events/${event.id}`}
        fontSize="heading-m"
        onFollow={(e) => {
          e.preventDefault();
          router.push(`/events/${event.id}`);
        }}
      >
        {event.name}
      </Link>
    ),
    sections: [
      {
        id: 'meta',
        header: t('dashboard.type'),
        content: (event: ParticipantEvent) => (
          <SpaceBetween direction="horizontal" size="xs">
            <Badge color={event.type === 'gameday' ? 'blue' : 'green'}>
              {event.type === 'gameday' ? 'Incident Drill' : 'Challenge'}
            </Badge>
            {getStatusIndicator(event.status, t)}
          </SpaceBetween>
        ),
      },
      {
        id: 'start',
        header: t('dashboard.start'),
        content: (event: ParticipantEvent) => formatDate(event.startTime),
      },
    ],
  };

  return (
    <PageLayout
      header={
        mounted ? (
          <Header variant="h1" description={t('dashboard.description')}>
            {t('dashboard.title')}
          </Header>
        ) : (
          <div>
            <h1 className="text-3xl font-bold">{t('dashboard.title')}</h1>
            <p className="mt-2 text-sm text-gray-500">
              {t('dashboard.description')}
            </p>
          </div>
        )
      }
    >
      <SpaceBetween size="xl">
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
            {/* Stats summary */}
            <ColumnLayout columns={3} variant="text-grid">
              <Container>
                <Box fontSize="display-l" fontWeight="bold" textAlign="center">
                  {activeEvents.length}
                </Box>
                <Box
                  color="text-body-secondary"
                  textAlign="center"
                  variant="small"
                >
                  {t('dashboard.active')}
                </Box>
              </Container>
              <Container>
                <Box fontSize="display-l" fontWeight="bold" textAlign="center">
                  {scheduledEvents.length}
                </Box>
                <Box
                  color="text-body-secondary"
                  textAlign="center"
                  variant="small"
                >
                  {t('dashboard.scheduled')}
                </Box>
              </Container>
              <Container>
                <Box fontSize="display-l" fontWeight="bold" textAlign="center">
                  {myEvents.length}
                </Box>
                <Box
                  color="text-body-secondary"
                  textAlign="center"
                  variant="small"
                >
                  合計
                </Box>
              </Container>
            </ColumnLayout>

            {/* Active events */}
            {activeEvents.length > 0 && (
              <Container
                header={<Header variant="h2">{t('dashboard.active')}</Header>}
              >
                <Cards
                  cardDefinition={cardDefinitionActive}
                  cardsPerRow={[{ cards: 1 }, { minWidth: 480, cards: 2 }]}
                  items={activeEvents}
                  loadingText={t('common.loading')}
                />
              </Container>
            )}

            {/* Scheduled (registered) events */}
            {scheduledEvents.length > 0 && (
              <Container
                header={
                  <Header variant="h2">{t('dashboard.scheduled')}</Header>
                }
              >
                <Cards
                  cardDefinition={cardDefinitionScheduled}
                  cardsPerRow={[
                    { cards: 1 },
                    { minWidth: 320, cards: 2 },
                    { minWidth: 960, cards: 3 },
                  ]}
                  items={scheduledEvents}
                  loadingText={t('common.loading')}
                />
              </Container>
            )}

            {/* No events CTA */}
            {myEvents.length === 0 && (
              <Container>
                <Box textAlign="center" padding="xxl">
                  <SpaceBetween size="m">
                    <Box fontSize="display-l">🏆</Box>
                    <Header variant="h2">{t('dashboard.noMyEvents')}</Header>
                    <Box color="text-body-secondary">
                      {t('dashboard.noEventsDescription')}
                    </Box>
                    <Button
                      variant="primary"
                      onClick={() => router.push('/events')}
                    >
                      {t('dashboard.browseEvents')}
                    </Button>
                  </SpaceBetween>
                </Box>
              </Container>
            )}
          </SpaceBetween>
        )}
      </SpaceBetween>
    </PageLayout>
  );
}
