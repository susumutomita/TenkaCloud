/**
 * Admin Dashboard Page
 *
 * Cloudscape Design System - Admin dashboard with stats and activity feed
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  getDashboardStats,
  getRecentActivities,
} from '@/lib/api/admin-dashboard';
import type { DashboardStats, ActivityEntry } from '@/lib/api/admin-dashboard';
import { useTenantOptional } from '@/lib/tenant';

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
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [statsData, activitiesData] = await Promise.all([
        getDashboardStats(),
        getRecentActivities(),
      ]);

      setStats(statsData);
      setRecentActivities(
        activitiesData.activities.map(
          (a: ActivityEntry): RecentActivity => ({
            id: a.id,
            type: a.type as RecentActivity['type'],
            message: a.message,
            timestamp: a.timestamp,
          }),
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error('データの読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

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

  const statItems = [
    {
      title: '開催中のイベント',
      value: stats?.activeEvents,
      href: '/admin/events?status=active',
    },
    {
      title: '総参加者数',
      value: stats?.totalParticipants,
      href: '/admin/participants',
    },
    {
      title: '総チーム数',
      value: stats?.totalTeams,
      href: '/admin/teams',
    },
    {
      title: '予定イベント',
      value: stats?.upcomingEvents,
      href: '/admin/events?status=scheduled',
    },
  ];

  return (
    <SpaceBetween size="l">
      {/* Header */}
      <Header
        variant="h1"
        description={
          tenant?.slug ? <span>tenant: {tenant.slug}</span> : undefined
        }
      >
        ダッシュボード
      </Header>

      {/* Error State */}
      {error && (
        <Container>
          <SpaceBetween size="s" direction="vertical" alignItems="center">
            <StatusIndicator type="error">{error.message}</StatusIndicator>
            <Button onClick={fetchDashboardData}>再試行</Button>
          </SpaceBetween>
        </Container>
      )}

      {/* Stats Grid - hidden when error */}
      {!error &&
        (loading ? (
          <Container>
            <Box textAlign="center" padding="l">
              <Spinner size="large" />
            </Box>
          </Container>
        ) : (
          <ColumnLayout columns={4} variant="text-grid">
            {statItems.map((item) => (
              <Container key={item.title}>
                <SpaceBetween size="xs">
                  <Box variant="awsui-key-label">{item.title}</Box>
                  <Box variant="awsui-value-large">
                    {item.value !== undefined
                      ? item.value.toLocaleString()
                      : '-'}
                  </Box>
                  <Link href={item.href}>詳細を見る</Link>
                </SpaceBetween>
              </Container>
            ))}
          </ColumnLayout>
        ))}

      {/* Quick Actions */}
      <Container header={<Header variant="h2">クイックアクション</Header>}>
        <SpaceBetween size="s" direction="horizontal">
          <Link href="/admin/events/new">
            <Button variant="primary" iconName="add-plus">
              新規イベント作成
            </Button>
          </Link>
          <Link href="/admin/participants/invite">
            <Button iconName="user-profile">参加者を招待</Button>
          </Link>
          <Link href="/admin/settings">
            <Button variant="link" iconName="settings">
              設定
            </Button>
          </Link>
        </SpaceBetween>
      </Container>

      {/* Recent Activity - hidden when error */}
      {!error && (
        <Container header={<Header variant="h2">最近のアクティビティ</Header>}>
          {loading ? (
            <Box textAlign="center" padding="l">
              <Spinner size="large" />
            </Box>
          ) : recentActivities.length === 0 ? (
            <Box textAlign="center" padding="l">
              <Box variant="p" color="text-status-inactive">
                まだアクティビティはありません
              </Box>
            </Box>
          ) : (
            <SpaceBetween size="m">
              {recentActivities.map((activity) => {
                const { icon } = getActivityIcon(activity.type);
                return (
                  <div
                    key={activity.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                    }}
                  >
                    <Box fontSize="heading-l">{icon}</Box>
                    <SpaceBetween size="xxs">
                      <Box variant="p">{activity.message}</Box>
                      <Box variant="small" color="text-status-inactive">
                        {formatTimestamp(activity.timestamp)}
                      </Box>
                    </SpaceBetween>
                  </div>
                );
              })}
            </SpaceBetween>
          )}
        </Container>
      )}
    </SpaceBetween>
  );
}
