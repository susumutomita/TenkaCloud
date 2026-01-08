/**
 * Admin Dashboard Page
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed admin dashboard with stats and activity feed
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTenantOptional } from '@/lib/tenant';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

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

interface StatCardProps {
  title: string;
  value: number;
  icon: string;
  href: string;
  accentColor: 'success' | 'accent' | 'warning' | 'error';
}

function StatCard({ title, value, icon, href, accentColor }: StatCardProps) {
  const accentClasses = {
    success: 'bg-hn-success/10 text-hn-success border-hn-success/30',
    accent: 'bg-hn-accent/10 text-hn-accent border-hn-accent/30',
    warning: 'bg-hn-warning/10 text-hn-warning border-hn-warning/30',
    error: 'bg-hn-error/10 text-hn-error border-hn-error/30',
  };

  return (
    <Card className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-muted uppercase tracking-wider">
              {title}
            </p>
            <p className="text-4xl font-bold text-text-primary mt-2 font-mono">
              {value.toLocaleString()}
            </p>
          </div>
          <div
            className={`w-14 h-14 rounded-[var(--radius)] flex items-center justify-center border ${accentClasses[accentColor]}`}
          >
            <span className="text-2xl">{icon}</span>
          </div>
        </div>
        <Link
          href={href}
          className="text-sm text-hn-accent hover:text-hn-accent-bright mt-4 inline-flex items-center gap-1 group-hover:gap-2 transition-all"
        >
          詳細を見る
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
              d="M9 5l7 7-7 7"
            />
          </svg>
        </Link>
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-16" />
          </div>
          <Skeleton className="w-14 h-14 rounded-[var(--radius)]" />
        </div>
        <Skeleton className="h-4 w-20 mt-4" />
      </CardContent>
    </Card>
  );
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
        return { icon: '📝', color: 'text-hn-accent' };
      case 'participant_joined':
        return { icon: '👤', color: 'text-hn-success' };
      case 'event_started':
        return { icon: '🚀', color: 'text-hn-warning' };
      case 'event_ended':
        return { icon: '🏁', color: 'text-text-muted' };
      default:
        return { icon: '📌', color: 'text-text-muted' };
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
            <span className="text-hn-accent font-mono">&gt;_</span>
            ダッシュボード
          </h1>
          {tenant?.slug && (
            <p className="text-text-muted mt-1 font-mono text-sm">
              tenant: {tenant.slug}
            </p>
          )}
        </div>
        <div className="text-sm font-mono text-text-muted">
          {new Date().toLocaleDateString('ja-JP', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'short',
          })}
        </div>
      </div>

      {/* Stats Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard
            title="開催中のイベント"
            value={stats.activeEvents}
            icon="🎮"
            href="/admin/events?status=active"
            accentColor="success"
          />
          <StatCard
            title="総参加者数"
            value={stats.totalParticipants}
            icon="👥"
            href="/admin/participants"
            accentColor="accent"
          />
          <StatCard
            title="総チーム数"
            value={stats.totalTeams}
            icon="🏆"
            href="/admin/teams"
            accentColor="warning"
          />
          <StatCard
            title="予定イベント"
            value={stats.upcomingEvents}
            icon="📅"
            href="/admin/events?status=scheduled"
            accentColor="error"
          />
        </div>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-hn-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            クイックアクション
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
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
                新規イベント作成
              </Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/admin/participants/invite">
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
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/admin/settings">
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
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-hn-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            最近のアクティビティ
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-start space-x-3">
                  <Skeleton className="w-10 h-10 rounded-[var(--radius)]" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : recentActivities.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              <svg
                className="w-12 h-12 mx-auto mb-4 text-text-muted/50"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                />
              </svg>
              <p className="font-mono">アクティビティはありません</p>
            </div>
          ) : (
            <div className="space-y-4">
              {recentActivities.map((activity) => {
                const { icon, color } = getActivityIcon(activity.type);
                return (
                  <div
                    key={activity.id}
                    className="flex items-start space-x-3 pb-4 border-b border-border last:border-0 last:pb-0"
                  >
                    <div
                      className={`w-10 h-10 rounded-[var(--radius)] bg-surface-2 flex items-center justify-center ${color}`}
                    >
                      <span className="text-xl">{icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary">
                        {activity.message}
                      </p>
                      <p className="text-xs text-text-muted mt-1 font-mono">
                        {formatTimestamp(activity.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> TenkaCloud Admin Console
        v0.1.0
      </div>
    </div>
  );
}
