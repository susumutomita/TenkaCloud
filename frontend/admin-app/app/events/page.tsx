'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EventCard } from '@/components/events/event-card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  deployEvent,
  EVENT_STATUSES,
  type Event,
  type EventStatus,
  getEvents,
  updateEventStatus,
} from '@/lib/api/events';
import { PROBLEM_TYPES, type ProblemType } from '@/lib/api/problems';

/** 通知メッセージの型 */
interface Notification {
  type: 'success' | 'error' | 'info';
  message: string;
}

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<EventStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ProblemType | ''>('');

  /** 通知を表示して自動的に消す */
  const showNotification = useCallback(
    (type: Notification['type'], message: string) => {
      setNotification({ type, message });
      setTimeout(() => setNotification(null), 5000);
    },
    []
  );

  /** ステータスフィルターの変更ハンドラー（型安全） */
  const handleStatusFilterChange = useCallback((value: string) => {
    if (value === '' || EVENT_STATUSES.includes(value as EventStatus)) {
      setStatusFilter(value as EventStatus | '');
    }
  }, []);

  /** タイプフィルターの変更ハンドラー（型安全） */
  const handleTypeFilterChange = useCallback((value: string) => {
    if (value === '' || PROBLEM_TYPES.includes(value as ProblemType)) {
      setTypeFilter(value as ProblemType | '');
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getEvents({
        status: statusFilter || undefined,
        type: typeFilter || undefined,
      });
      setEvents(result.events);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'イベントの取得に失敗しました';
      setError(message);
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleDeploy = async (eventId: string) => {
    setActionInProgress(eventId);
    try {
      const result = await deployEvent(eventId);
      showNotification(
        'success',
        `デプロイを開始しました (Job ID: ${result.jobId})`
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'デプロイに失敗しました';
      showNotification('error', message);
      console.error('Failed to deploy event:', err);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleStart = async (eventId: string) => {
    if (!window.confirm('イベントを開始しますか？')) {
      return;
    }
    setActionInProgress(eventId);
    try {
      await updateEventStatus(eventId, 'active');
      showNotification('success', 'イベントを開始しました');
      loadEvents();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'イベントの開始に失敗しました';
      showNotification('error', message);
      console.error('Failed to start event:', err);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleViewDetails = (eventId: string) => {
    window.location.href = `/events/${eventId}`;
  };

  // 統計情報を計算
  const stats = {
    total: events.length,
    draft: events.filter((e) => e.status === 'draft').length,
    scheduled: events.filter((e) => e.status === 'scheduled').length,
    active: events.filter((e) => e.status === 'active').length,
    completed: events.filter((e) => e.status === 'completed').length,
  };

  return (
    <div className="container mx-auto px-4 py-8">
      {/* 通知トースト */}
      {notification && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg transition-all ${
            notification.type === 'success'
              ? 'bg-green-100 border border-green-400 text-green-700'
              : notification.type === 'error'
                ? 'bg-red-100 border border-red-400 text-red-700'
                : 'bg-blue-100 border border-blue-400 text-blue-700'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' && (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {notification.type === 'error' && (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            <span>{notification.message}</span>
            <button
              type="button"
              onClick={() => setNotification(null)}
              className="ml-2 text-current opacity-70 hover:opacity-100"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">イベント管理</h1>
          <p className="text-muted-foreground">
            GameDay / JAM イベントの作成・管理
          </p>
        </div>
        <Link href="/events/new">
          <Button>
            <svg
              className="h-4 w-4 mr-2"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
            新規イベント
          </Button>
        </Link>
      </div>

      {/* 統計カード */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-sm text-muted-foreground">全イベント</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-gray-600">{stats.draft}</div>
          <div className="text-sm text-muted-foreground">下書き</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-blue-600">
            {stats.scheduled}
          </div>
          <div className="text-sm text-muted-foreground">予定</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-green-600">
            {stats.active}
          </div>
          <div className="text-sm text-muted-foreground">開催中</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-purple-600">
            {stats.completed}
          </div>
          <div className="text-sm text-muted-foreground">終了</div>
        </div>
      </div>

      {/* フィルター */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <label htmlFor="status-filter" className="text-sm font-medium">
            ステータス:
          </label>
          <Select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value)}
            className="w-32"
          >
            <option value="">すべて</option>
            <option value="draft">下書き</option>
            <option value="scheduled">予定</option>
            <option value="active">開催中</option>
            <option value="paused">一時停止</option>
            <option value="completed">終了</option>
            <option value="cancelled">キャンセル</option>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="type-filter" className="text-sm font-medium">
            タイプ:
          </label>
          <Select
            id="type-filter"
            value={typeFilter}
            onChange={(e) => handleTypeFilterChange(e.target.value)}
            className="w-32"
          >
            <option value="">すべて</option>
            <option value="gameday">GameDay</option>
            <option value="jam">JAM</option>
          </Select>
        </div>
      </div>

      {/* イベント一覧 */}
      {error ? (
        <div className="text-center py-12 border rounded-lg bg-red-50">
          <svg
            className="mx-auto h-12 w-12 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-red-800">
            エラーが発生しました
          </h3>
          <p className="mt-1 text-sm text-red-600">{error}</p>
          <Button variant="outline" className="mt-4" onClick={loadEvents}>
            再読み込み
          </Button>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={`skeleton-${i}`}
              className="h-72 bg-gray-100 animate-pulse rounded-lg"
            />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-card">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
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
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            イベントがありません
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            新しいイベントを作成して、GameDay や JAM を開催しましょう
          </p>
          <Link href="/events/new">
            <Button className="mt-4">
              <svg
                className="h-4 w-4 mr-2"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                  clipRule="evenodd"
                />
              </svg>
              新規イベント
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              onViewDetails={handleViewDetails}
              onDeploy={handleDeploy}
              onStart={handleStart}
            />
          ))}
        </div>
      )}
    </div>
  );
}
