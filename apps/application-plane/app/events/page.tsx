/**
 * Events List Page
 *
 * Cloudscape Design System — イベント一覧ページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '../../components/layout';
import { useI18n } from '../../lib/i18n';
import { getAvailableEvents } from '../../lib/api/events';
import type {
  EventStatus,
  ParticipantEvent,
  ProblemType,
} from '../../lib/api/types';

function getEventStatusIndicator(
  status: EventStatus,
  t: (k: string) => string,
) {
  switch (status) {
    case 'active':
      return (
        <StatusIndicator type="success">{t('events.active')}</StatusIndicator>
      );
    case 'scheduled':
      return (
        <StatusIndicator type="pending">
          {t('events.scheduled')}
        </StatusIndicator>
      );
    case 'completed':
      return (
        <StatusIndicator type="stopped">
          {t('events.completed')}
        </StatusIndicator>
      );
    case 'cancelled':
      return (
        <StatusIndicator type="error">{t('events.cancelled')}</StatusIndicator>
      );
    case 'paused':
      return (
        <StatusIndicator type="warning">{t('events.paused')}</StatusIndicator>
      );
    default:
      return <StatusIndicator type="info">{status}</StatusIndicator>;
  }
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getTimeUntilStart(startTime: string) {
  const now = new Date();
  const start = new Date(startTime);
  const diff = start.getTime() - now.getTime();

  if (diff <= 0) return null;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `あと ${days}日 ${hours}時間`;
  if (hours > 0) return `あと ${hours}時間`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `あと ${minutes}分`;
}

export default function EventsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [events, setEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const statusOptions: SelectProps.Option[] = [
    { value: '', label: t('events.all') },
    { value: 'active', label: t('events.active') },
    { value: 'scheduled', label: t('events.scheduled') },
  ];

  const typeOptions: SelectProps.Option[] = [
    { value: '', label: t('events.all') },
    { value: 'gameday', label: t('events.gameday') },
    { value: 'jam', label: t('events.jam') },
  ];

  const [selectedStatus, setSelectedStatus] =
    useState<SelectProps.Option | null>(null);
  const [selectedType, setSelectedType] = useState<SelectProps.Option | null>(
    null,
  );

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        const statusFilter = selectedStatus?.value
          ? [selectedStatus.value as EventStatus]
          : ['scheduled', 'active'];
        const res = await getAvailableEvents({
          status: statusFilter as EventStatus[],
          type: (selectedType?.value as ProblemType) || undefined,
          limit: 50,
        });
        setEvents(res.events);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました'),
        );
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [selectedStatus, selectedType]);

  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <Cards
            cardDefinition={{
              header: (event) => (
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
                  id: 'status',
                  header: t('events.statusLabel'),
                  content: (event) => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {getEventStatusIndicator(event.status, t)}
                      <Badge
                        color={event.type === 'gameday' ? 'blue' : 'green'}
                      >
                        {event.type === 'gameday'
                          ? t('events.gameday')
                          : t('events.jam')}
                      </Badge>
                      {event.isRegistered && (
                        <Badge color="green">{t('events.registered')}</Badge>
                      )}
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'schedule',
                  header: t('events.schedule'),
                  content: (event) => {
                    const timeUntil =
                      event.status === 'scheduled'
                        ? getTimeUntilStart(event.startTime)
                        : null;
                    return (
                      <SpaceBetween size="xxs">
                        <Box variant="small">
                          {t('events.startTime')}: {formatDate(event.startTime)}
                        </Box>
                        <Box variant="small">
                          {t('events.endTime')}: {formatDate(event.endTime)}
                        </Box>
                        {timeUntil && (
                          <Box color="text-status-info" fontWeight="bold">
                            {timeUntil}
                          </Box>
                        )}
                      </SpaceBetween>
                    );
                  },
                },
                {
                  id: 'details',
                  header: t('events.details'),
                  content: (event) => (
                    <SpaceBetween direction="horizontal" size="l">
                      <Box variant="small">
                        {t('events.problems')}:{' '}
                        <Box variant="span" fontWeight="bold">
                          {event.problemCount}
                        </Box>
                      </Box>
                      <Box variant="small">
                        {t('events.participants')}:{' '}
                        <Box variant="span" fontWeight="bold">
                          {event.participantCount}
                        </Box>
                      </Box>
                      <Box variant="small">
                        {event.cloudProvider.toUpperCase()}
                      </Box>
                      <Box variant="small">
                        {event.participantType === 'team'
                          ? t('events.team')
                          : t('events.solo')}
                      </Box>
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'action',
                  content: (event) => (
                    <Button
                      variant={event.status === 'active' ? 'primary' : 'normal'}
                      fullWidth
                      onClick={() => router.push(`/events/${event.id}`)}
                    >
                      {event.status === 'active'
                        ? event.isRegistered
                          ? t('events.joinBattle')
                          : t('events.joinNow')
                        : event.isRegistered
                          ? t('events.viewDetails')
                          : t('events.register')}
                    </Button>
                  ),
                },
              ],
            }}
            cardsPerRow={[
              { cards: 1 },
              { minWidth: 600, cards: 2 },
              { minWidth: 1000, cards: 3 },
            ]}
            items={events}
            loading={loading}
            loadingText={t('events.loading')}
            header={
              <Header
                counter={!loading && !error ? `(${events.length})` : undefined}
                description={t('events.description')}
              >
                {t('events.title')}
              </Header>
            }
            filter={
              <SpaceBetween direction="horizontal" size="l">
                <Select
                  selectedOption={selectedStatus}
                  onChange={({ detail }) =>
                    setSelectedStatus(detail.selectedOption)
                  }
                  options={statusOptions}
                  placeholder={t('events.statusLabel')}
                />
                <Select
                  selectedOption={selectedType}
                  onChange={({ detail }) =>
                    setSelectedType(detail.selectedOption)
                  }
                  options={typeOptions}
                  placeholder={t('events.typeLabel')}
                />
              </SpaceBetween>
            }
            empty={
              error ? (
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <StatusIndicator type="error">
                      {error.message}
                    </StatusIndicator>
                    <Button onClick={() => window.location.reload()}>
                      {t('common.retry')}
                    </Button>
                  </SpaceBetween>
                </Box>
              ) : (
                <Box textAlign="center" color="inherit">
                  <SpaceBetween size="m">
                    <b>{t('events.empty')}</b>
                    <Box variant="p" color="inherit">
                      {t('events.emptyDescription')}
                    </Box>
                  </SpaceBetween>
                </Box>
              )
            }
          />
        </div>
      </main>
    </div>
  );
}
