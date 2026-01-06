/**
 * Admin Dashboard Page
 *
 * 管理者ダッシュボード
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTenantOptional } from '@/lib/tenant';

interface DashboardStats {
  activeEvents: number;
  totalParticipants: number;
  totalTeams: number;
  upcomingEvents: number;
}

interface RecentActivity {
  id: string;
  type:
    | 'event_created'
    | 'participant_joined'
    | 'event_started'
    | 'event_ended';
  message: string;
  timestamp: string;
}

export default function AdminDashboardPage() {
  const tenant = useTenantOptional();
  const [stats, setStats] = useState<DashboardStats>({
    activeEvents: 0,
    totalParticipants: 0,
    totalTeams: 0,
    upcomingEvents: 0,
  });
  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>(
    []
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchDashboardData = async () => {
      try {
        setLoading(true);
        // Mock data for now
        setStats({
          activeEvents: 2,
          totalParticipants: 156,
          totalTeams: 23,
          upcomingEvents: 5,
        });
        setRecentActivities([
          {
            id: '1',
            type: 'event_started',
            message: 'AWS GameDay 2024 Winter が開始されました',
            timestamp: new Date().toISOString(),
          },
          {
            id: '2',
            type: 'participant_joined',
            message: '新しい参加者が登録しました',
            timestamp: new Date(Date.now() - 3600000).toISOString(),
          },
          {
            id: '3',
            type: 'event_created',
            message: 'Security JAM が作成されました',
            timestamp: new Date(Date.now() - 7200000).toISOString(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor(diff / (1000 * 60));

    if (hours > 24) {
      return date.toLocaleDateString('ja-JP', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    if (hours > 0) {
      return `${hours}時間前`;
    }
    if (minutes > 0) {
      return `${minutes}分前`;
    }
    return 'たった今';
  };

  const getActivityIcon = (type: RecentActivity['type']) => {
    switch (type) {
      case 'event_created':
        return '📝';
      case 'participant_joined':
        return '👤';
      case 'event_started':
        return '🚀';
      case 'event_ended':
        return '🏁';
      default:
        return '📌';
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>
        {tenant?.slug && (
          <p className="text-gray-500 mt-1">テナント: {tenant.slug}</p>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">
                開催中のイベント
              </p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {stats.activeEvents}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <span className="text-2xl">🎮</span>
            </div>
          </div>
          <Link
            href="/admin/events?status=active"
            className="text-sm text-blue-600 hover:text-blue-700 mt-4 inline-block"
          >
            詳細を見る →
          </Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">総参加者数</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {stats.totalParticipants}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <span className="text-2xl">👥</span>
            </div>
          </div>
          <Link
            href="/admin/participants"
            className="text-sm text-blue-600 hover:text-blue-700 mt-4 inline-block"
          >
            詳細を見る →
          </Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">総チーム数</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {stats.totalTeams}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
              <span className="text-2xl">🏆</span>
            </div>
          </div>
          <Link
            href="/admin/teams"
            className="text-sm text-blue-600 hover:text-blue-700 mt-4 inline-block"
          >
            詳細を見る →
          </Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">予定イベント</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {stats.upcomingEvents}
              </p>
            </div>
            <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
              <span className="text-2xl">📅</span>
            </div>
          </div>
          <Link
            href="/admin/events?status=scheduled"
            className="text-sm text-blue-600 hover:text-blue-700 mt-4 inline-block"
          >
            詳細を見る →
          </Link>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          クイックアクション
        </h2>
        <div className="flex flex-wrap gap-4">
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
            新規イベント作成
          </Link>
          <Link
            href="/admin/participants/invite"
            className="inline-flex items-center px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
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
                d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
              />
            </svg>
            参加者を招待
          </Link>
          <Link
            href="/admin/settings"
            className="inline-flex items-center px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            設定
          </Link>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          最近のアクティビティ
        </h2>
        <div className="space-y-4">
          {recentActivities.map((activity) => (
            <div
              key={activity.id}
              className="flex items-start space-x-3 pb-4 border-b border-gray-100 last:border-0 last:pb-0"
            >
              <span className="text-xl">{getActivityIcon(activity.type)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-900">{activity.message}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {formatTimestamp(activity.timestamp)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
