/**
 * Events List Page
 *
 * Cloudscape Design System — イベント一覧（カード/リスト/カレンダービュー）
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageLayout } from '../../components/layout';
import { useI18n } from '../../lib/i18n';
import { getAvailableEvents } from '../../lib/api/events';
import type {
  EventStatus,
  ParticipantEvent,
  ProblemType,
} from '../../lib/api/types';

type ViewMode = 'cards' | 'list' | 'calendar';

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
  return date.toLocaleDateString(undefined, {
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
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${minutes}m`;
}

function getActionLabel(event: ParticipantEvent, t: (k: string) => string) {
  if (event.status === 'active') {
    return event.isRegistered ? t('events.joinBattle') : t('events.joinNow');
  }
  return event.isRegistered ? t('events.viewDetails') : t('events.register');
}

// ─── Calendar View ───────────────────────────────────────────────────────────

const DAY_NAMES_JA = ['月', '火', '水', '木', '金', '土', '日'];
const DAY_NAMES_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface CalendarViewProps {
  events: ParticipantEvent[];
  t: (k: string) => string;
  locale: string;
  onNavigate: (path: string) => void;
}

function CalendarView({ events, t, locale, onNavigate }: CalendarViewProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Monday-first: Sun=0 → offset 6, Mon=1 → offset 0, …
  const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7;

  // Group events by day-of-month that start in this month
  const eventsByDay: Record<number, ParticipantEvent[]> = {};
  for (const event of events) {
    const d = new Date(event.startTime);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      (eventsByDay[day] ??= []).push(event);
    }
  }

  const cells: (number | null)[] = [
    ...Array<null>(firstDayOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const isToday = (day: number) =>
    today.getFullYear() === year &&
    today.getMonth() === month &&
    today.getDate() === day;

  const dayNames = locale === 'ja' ? DAY_NAMES_JA : DAY_NAMES_EN;
  const monthLabel =
    locale === 'ja'
      ? `${year}年${month + 1}月`
      : new Date(year, month, 1).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
        });

  return (
    <SpaceBetween size="s">
      {/* Month navigation */}
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Button
          variant="icon"
          iconName="angle-left"
          ariaLabel={t('events.calendarPrev')}
          onClick={() =>
            setCurrentMonth(
              (prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
            )
          }
        />
        <Box fontSize="heading-m" fontWeight="bold">
          {monthLabel}
        </Box>
        <Button
          variant="icon"
          iconName="angle-right"
          ariaLabel={t('events.calendarNext')}
          onClick={() =>
            setCurrentMonth(
              (prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
            )
          }
        />
      </SpaceBetween>

      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 1,
          background: 'var(--color-border-divider-default)',
        }}
      >
        {/* Day headers */}
        {dayNames.map((name, i) => (
          <div
            key={name}
            style={{
              padding: '6px 4px',
              textAlign: 'center',
              background: 'var(--color-background-container-header)',
              fontSize: '0.8rem',
              fontWeight: 600,
              color:
                i >= 5
                  ? 'var(--color-text-status-error)'
                  : 'var(--color-text-body-secondary)',
            }}
          >
            {name}
          </div>
        ))}

        {/* Day cells */}
        {cells.map((day, i) => (
          <div
            key={i}
            style={{
              minHeight: 72,
              padding: '4px 6px',
              background:
                day && isToday(day)
                  ? 'var(--color-background-status-info)'
                  : 'var(--color-background-layout-main)',
            }}
          >
            {day !== null && (
              <SpaceBetween size="xxs">
                <Box
                  variant="small"
                  fontWeight={isToday(day) ? 'bold' : 'normal'}
                  color={
                    isToday(day) ? 'text-status-info' : 'text-body-secondary'
                  }
                >
                  {day}
                </Box>
                {(eventsByDay[day] ?? []).map((event) => (
                  <div
                    key={event.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNavigate(`/events/${event.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onNavigate(`/events/${event.id}`);
                    }}
                    title={event.name}
                    style={{
                      background:
                        event.status === 'active'
                          ? 'var(--color-background-status-success)'
                          : 'var(--color-background-status-info)',
                      borderRadius: 3,
                      padding: '1px 4px',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      fontSize: '0.75rem',
                    }}
                  >
                    {event.name}
                  </div>
                ))}
              </SpaceBetween>
            )}
          </div>
        ))}
      </div>
    </SpaceBetween>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EventsPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [events, setEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');

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

  const emptyNode = error ? (
    <Box textAlign="center" color="inherit">
      <SpaceBetween size="m">
        <StatusIndicator type="error">{error.message}</StatusIndicator>
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
  );

  const filterBar = (
    <SpaceBetween direction="horizontal" size="s">
      <Select
        selectedOption={selectedStatus}
        onChange={({ detail }) => setSelectedStatus(detail.selectedOption)}
        options={statusOptions}
        placeholder={t('events.statusLabel')}
      />
      <Select
        selectedOption={selectedType}
        onChange={({ detail }) => setSelectedType(detail.selectedOption)}
        options={typeOptions}
        placeholder={t('events.typeLabel')}
      />
    </SpaceBetween>
  );

  const viewToggle = (
    <SegmentedControl
      selectedId={viewMode}
      onChange={({ detail }) => setViewMode(detail.selectedId as ViewMode)}
      options={[
        { id: 'cards', text: t('events.viewCards') },
        { id: 'list', text: t('events.viewList') },
        { id: 'calendar', text: t('events.viewCalendar') },
      ]}
    />
  );

  return (
    <PageLayout>
      <SpaceBetween size="l">
        <Header
          counter={!loading && !error ? `(${events.length})` : undefined}
          description={t('events.description')}
          actions={viewToggle}
        >
          {t('events.title')}
        </Header>

        {filterBar}

        {loading ? (
          <Box textAlign="center" padding="xl">
            <Spinner size="large" />
          </Box>
        ) : viewMode === 'cards' ? (
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
                      {getActionLabel(event, t)}
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
            empty={emptyNode}
          />
        ) : viewMode === 'list' ? (
          <Table
            columnDefinitions={[
              {
                id: 'name',
                header: t('events.name'),
                cell: (event) => (
                  <Link
                    href={`/events/${event.id}`}
                    onFollow={(e) => {
                      e.preventDefault();
                      router.push(`/events/${event.id}`);
                    }}
                  >
                    {event.name}
                  </Link>
                ),
                minWidth: 200,
              },
              {
                id: 'status',
                header: t('events.statusLabel'),
                cell: (event) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    {getEventStatusIndicator(event.status, t)}
                    <Badge color={event.type === 'gameday' ? 'blue' : 'green'}>
                      {event.type === 'gameday'
                        ? t('events.gameday')
                        : t('events.jam')}
                    </Badge>
                  </SpaceBetween>
                ),
                width: 220,
              },
              {
                id: 'start',
                header: t('events.startTime'),
                cell: (event) => formatDate(event.startTime),
                width: 160,
              },
              {
                id: 'end',
                header: t('events.endTime'),
                cell: (event) => formatDate(event.endTime),
                width: 160,
              },
              {
                id: 'participants',
                header: t('events.participants'),
                cell: (event) => event.participantCount,
                width: 110,
              },
              {
                id: 'action',
                header: '',
                cell: (event) => (
                  <Button
                    variant={event.status === 'active' ? 'primary' : 'normal'}
                    onClick={() => router.push(`/events/${event.id}`)}
                  >
                    {getActionLabel(event, t)}
                  </Button>
                ),
                width: 140,
              },
            ]}
            items={events}
            empty={emptyNode}
          />
        ) : (
          <CalendarView
            events={events}
            t={t}
            locale={locale}
            onNavigate={(path) => router.push(path)}
          />
        )}
      </SpaceBetween>
    </PageLayout>
  );
}
