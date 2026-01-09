/**
 * Admin Events List Page
 *
 * HybridNext Design System - Terminal Command Center style
 * イベント管理一覧
 */

'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EventStatusBadge, ProblemTypeBadge } from '@/components/ui';
import type { AdminEvent, EventStatus } from '@/lib/api/admin-types';

export default function AdminEventsPage() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ status?: EventStatus }>({});
  const statusFilterId = useId();

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchEvents = async () => {
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
    };

    fetchEvents();
  }, [filter]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const filteredEvents = filter.status
    ? events.filter((e) => e.status === filter.status)
    : events;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          イベント管理
        </h1>
        <Button asChild>
          <Link href="/admin/events/new">
            <svg
              className="w-5 h-5 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            新規イベント
          </Link>
        </Button>
      </div>

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
      ) : !error && filteredEvents.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">📭</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            イベントがありません
          </h2>
          <p className="text-text-muted mb-6">
            新しいイベントを作成して始めましょう。
          </p>
          <Button asChild>
            <Link href="/admin/events/new">新規イベント作成</Link>
          </Button>
        </Card>
      ) : !error ? (
        <div className="space-y-4">
          {filteredEvents.map((event) => (
            <Card
              key={event.id}
              className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]"
            >
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
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                        {formatDate(event.startTime)}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                        </svg>
                        {event.participantCount} / {event.maxParticipants}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                          />
                        </svg>
                        {event.problemCount} 問
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" asChild>
                      <Link href={`/admin/events/${event.id}`}>
                        <svg
                          className="w-4 h-4 mr-1"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
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
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> events --list --count=
        {filteredEvents.length}
      </div>
    </div>
  );
}
