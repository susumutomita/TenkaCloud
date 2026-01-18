/**
 * Admin Events List Page
 *
 * HybridNext Design System - Terminal Command Center style
 * イベント管理一覧
 */

'use client';

import {
  Calendar,
  ClipboardList,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import {
  AdminPageFooter,
  AdminPageHeader,
  EmptyState,
} from '@/components/admin';
import { EventStatusBadge, ProblemTypeBadge, Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { AdminEvent, EventStatus } from '@/lib/api/admin-types';
import { formatDateTime } from '@/lib/utils';

export default function AdminEventsPage() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ status?: EventStatus }>({});
  const statusFilterId = useId();

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (filter.status) params.set('status', filter.status);

        const response = await fetch(`/api/admin/events?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `イベントの取得に失敗しました (${response.status})`
          );
        }

        const data = await response.json();
        setEvents(data.events || []);
      } catch (err) {
        console.error('Failed to fetch events:', err);
        setError(
          err instanceof Error ? err.message : 'イベントの取得に失敗しました'
        );
        setEvents([]);
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [filter]);

  const filteredEvents = filter.status
    ? events.filter((e) => e.status === filter.status)
    : events;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="イベント管理"
        actions={
          <Button asChild>
            <Link href="/admin/events/new">
              <Plus className="w-5 h-5 mr-2" />
              新規イベント
            </Link>
          </Button>
        }
      />

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label
                htmlFor={statusFilterId}
                className="block text-sm font-medium text-text-muted mb-1"
              >
                ステータス
              </label>
              <select
                id={statusFilterId}
                className="bg-surface-1 border border-border rounded-[var(--radius)] px-3 py-2 text-text-primary focus:ring-hn-accent focus:border-hn-accent focus:outline-none"
                value={filter.status || ''}
                onChange={(e) =>
                  setFilter({
                    status: (e.target.value as EventStatus) || undefined,
                  })
                }
              >
                <option value="">すべて</option>
                <option value="draft">下書き</option>
                <option value="scheduled">予定</option>
                <option value="active">開催中</option>
                <option value="completed">終了</option>
              </select>
            </div>
            <div className="text-sm text-text-muted font-mono">
              {filteredEvents.length} 件のイベント
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error State */}
      {error && (
        <Card className="border-hn-error/50 bg-hn-error/10">
          <CardContent className="p-6 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-hn-error mb-2">
              エラーが発生しました
            </h2>
            <p className="text-text-muted mb-4">{error}</p>
            <Button
              variant="secondary"
              onClick={() => setFilter({ ...filter })}
            >
              再読み込み
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Events List */}
      {!error && loading ? (
        <EventsLoadingSkeleton />
      ) : !error && filteredEvents.length === 0 ? (
        <EmptyState
          icon="📭"
          title="イベントがありません"
          description="新しいイベントを作成して始めましょう。"
          action={
            <Button asChild>
              <Link href="/admin/events/new">新規イベント作成</Link>
            </Button>
          }
        />
      ) : !error ? (
        <div className="space-y-4">
          {filteredEvents.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      ) : null}

      <AdminPageFooter command="events" count={filteredEvents.length} />
    </div>
  );
}

function EventsLoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-6 w-64" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-10 w-24" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface EventCardProps {
  event: AdminEvent;
}

function EventCard({ event }: EventCardProps) {
  return (
    <Card className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Link
                href={`/admin/events/${event.id}`}
                className="text-lg font-semibold text-text-primary hover:text-hn-accent transition-colors"
              >
                {event.name}
              </Link>
              <ProblemTypeBadge type={event.type} />
              <EventStatusBadge status={event.status} />
            </div>
            <div className="flex items-center gap-6 text-sm text-text-muted">
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />
                {formatDateTime(event.startTime)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-4 h-4" />
                {event.participantCount} / {event.maxParticipants}
              </span>
              <span className="flex items-center gap-1">
                <ClipboardList className="w-4 h-4" />
                {event.problemCount} 問
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <Link href={`/admin/events/${event.id}`}>
                <Pencil className="w-4 h-4 mr-1" />
                編集
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-hn-error hover:text-hn-error hover:bg-hn-error/10"
              onClick={() => {
                // TODO: Implement delete
              }}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
