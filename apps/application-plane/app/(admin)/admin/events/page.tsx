/**
 * Admin Events List Page
 *
 * イベント管理一覧
 */

'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';

interface AdminEvent {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'active' | 'ended';
  type: 'gameday' | 'jam';
  startTime: string;
  endTime: string;
  participantCount: number;
  maxParticipants: number;
}

export default function AdminEventsPage() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ status?: string }>({});
  const statusFilterId = useId();

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchEvents = async () => {
      try {
        setLoading(true);
        // Mock data for now
        setEvents([
          {
            id: 'evt-1',
            name: 'AWS GameDay 2024 Winter',
            status: 'active',
            type: 'gameday',
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 86400000).toISOString(),
            participantCount: 45,
            maxParticipants: 100,
          },
          {
            id: 'evt-2',
            name: 'Security JAM',
            status: 'scheduled',
            type: 'jam',
            startTime: new Date(Date.now() + 172800000).toISOString(),
            endTime: new Date(Date.now() + 259200000).toISOString(),
            participantCount: 23,
            maxParticipants: 50,
          },
          {
            id: 'evt-3',
            name: 'Cloud Architecture Challenge',
            status: 'draft',
            type: 'gameday',
            startTime: new Date(Date.now() + 604800000).toISOString(),
            endTime: new Date(Date.now() + 691200000).toISOString(),
            participantCount: 0,
            maxParticipants: 100,
          },
        ]);
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

  const getStatusBadge = (status: AdminEvent['status']) => {
    const styles = {
      draft: 'bg-gray-100 text-gray-800',
      scheduled: 'bg-blue-100 text-blue-800',
      active: 'bg-green-100 text-green-800',
      ended: 'bg-gray-100 text-gray-500',
    };
    const labels = {
      draft: '下書き',
      scheduled: '予定',
      active: '開催中',
      ended: '終了',
    };
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}
      >
        {labels[status]}
      </span>
    );
  };

  const getTypeBadge = (type: AdminEvent['type']) => {
    const styles = {
      gameday: 'bg-orange-100 text-orange-800',
      jam: 'bg-purple-100 text-purple-800',
    };
    const labels = {
      gameday: 'GameDay',
      jam: 'JAM',
    };
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[type]}`}
      >
        {labels[type]}
      </span>
    );
  };

  const filteredEvents = filter.status
    ? events.filter((e) => e.status === filter.status)
    : events;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">イベント管理</h1>
        <Link
          href="/admin/events/new"
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
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
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap gap-4">
          <div>
            <label
              htmlFor={statusFilterId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              ステータス
            </label>
            <select
              id={statusFilterId}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
              value={filter.status || ''}
              onChange={(e) =>
                setFilter({ status: e.target.value || undefined })
              }
            >
              <option value="">すべて</option>
              <option value="draft">下書き</option>
              <option value="scheduled">予定</option>
              <option value="active">開催中</option>
              <option value="ended">終了</option>
            </select>
          </div>
        </div>
      </div>

      {/* Events Table */}
      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-4">📭</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            イベントがありません
          </h2>
          <p className="text-gray-500 mb-6">
            新しいイベントを作成して始めましょう。
          </p>
          <Link
            href="/admin/events/new"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            新規イベント作成
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  イベント名
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  タイプ
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  ステータス
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  期間
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  参加者
                </th>
                <th scope="col" className="relative px-6 py-3">
                  <span className="sr-only">アクション</span>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredEvents.map((event) => (
                <tr key={event.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link
                      href={`/admin/events/${event.id}`}
                      className="text-sm font-medium text-gray-900 hover:text-blue-600"
                    >
                      {event.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getTypeBadge(event.type)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(event.status)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    <div>{formatDate(event.startTime)}</div>
                    <div className="text-xs text-gray-400">
                      〜 {formatDate(event.endTime)}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {event.participantCount} / {event.maxParticipants}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <Link
                      href={`/admin/events/${event.id}`}
                      className="text-blue-600 hover:text-blue-900 mr-4"
                    >
                      編集
                    </Link>
                    <button
                      type="button"
                      className="text-red-600 hover:text-red-900"
                      onClick={() => {
                        // TODO: Implement delete
                      }}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
