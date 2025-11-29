'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { EventCard } from '@/components/events/event-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import {
  getEvents,
  deployEvent,
  updateEventStatus,
  type Event,
  type EventStatus,
} from '@/lib/api/events';
import type { ProblemType } from '@/lib/api/problems';

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<EventStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ProblemType | ''>('');

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getEvents({
        status: statusFilter || undefined,
        type: typeFilter || undefined,
      });
      setEvents(result.events);
      setTotal(result.total);
    } catch (error) {
      console.error('Failed to load events:', error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleDeploy = async (eventId: string) => {
    setDeploying(eventId);
    try {
      const result = await deployEvent(eventId);
      alert(`デプロイを開始しました (Job ID: ${result.jobId})`);
      // TODO: 進捗監視モーダルを表示
    } catch (error) {
      console.error('Failed to deploy event:', error);
      alert('デプロイに失敗しました');
    } finally {
      setDeploying(null);
    }
  };

  const handleStart = async (eventId: string) => {
    if (!confirm('イベントを開始しますか？')) {
      return;
    }
    try {
      await updateEventStatus(eventId, 'active');
      alert('イベントを開始しました');
      loadEvents();
    } catch (error) {
      console.error('Failed to start event:', error);
      alert('イベントの開始に失敗しました');
    }
  };

  const handleViewDetails = (eventId: string) => {
    // TODO: イベント詳細ページに遷移
    console.log('View details:', eventId);
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
            <svg className="h-4 w-4 mr-2" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
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
          <div className="text-2xl font-bold text-blue-600">{stats.scheduled}</div>
          <div className="text-sm text-muted-foreground">予定</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-green-600">{stats.active}</div>
          <div className="text-sm text-muted-foreground">開催中</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-2xl font-bold text-purple-600">{stats.completed}</div>
          <div className="text-sm text-muted-foreground">終了</div>
        </div>
      </div>

      {/* フィルター */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">ステータス:</label>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EventStatus)}
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
          <label className="text-sm font-medium">タイプ:</label>
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ProblemType)}
            className="w-32"
          >
            <option value="">すべて</option>
            <option value="gameday">GameDay</option>
            <option value="jam">JAM</option>
          </Select>
        </div>
      </div>

      {/* イベント一覧 */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
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
              <svg className="h-4 w-4 mr-2" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
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
