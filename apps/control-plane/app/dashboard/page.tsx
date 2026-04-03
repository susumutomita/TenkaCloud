/**
 * Dashboard Page
 *
 * Cloudscape Design System — Container + ColumnLayout
 */

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/auth';
import { fetchActivities } from '@/lib/api/activities-api';
import { fetchDashboardStats, type DashboardStats } from '@/lib/api/stats-api';
import type { Activity } from '@/types/activity';

async function getStats(): Promise<DashboardStats | null> {
  try {
    return await fetchDashboardStats();
  } catch {
    return null;
  }
}

async function getActivities(): Promise<Activity[]> {
  try {
    const result = await fetchActivities(5);
    return result.data;
  } catch {
    return [];
  }
}

function formatActivityMessage(activity: Activity): string {
  const actionLabels: Record<string, string> = {
    CREATE: '作成',
    UPDATE: '更新',
    DELETE: '削除',
    LOGIN: 'ログイン',
    LOGOUT: 'ログアウト',
    ACCESS: 'アクセス',
  };

  const resourceLabels: Record<string, string> = {
    TENANT: 'テナント',
    USER: 'ユーザー',
    BATTLE: 'バトル',
    PROBLEM: '問題',
    SETTING: '設定',
    SYSTEM: 'システム',
  };

  const action = actionLabels[activity.action] || activity.action;
  const resource =
    resourceLabels[activity.resourceType] || activity.resourceType;

  return `${resource}を${action}しました`;
}

function formatRelativeTime(timestamp: string): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'たった今';
  if (diffMins < 60) return `${diffMins}分前`;
  if (diffHours < 24) return `${diffHours}時間前`;
  if (diffDays < 7) return `${diffDays}日前`;

  return date.toLocaleDateString('ja-JP');
}

export default async function DashboardPage() {
  const session = await getSession();

  if (!session?.user) {
    redirect('/login');
  }

  const [stats, activities] = await Promise.all([getStats(), getActivities()]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`ようこそ、${session.user.name || session.user.email} さん`}
      >
        ダッシュボード
      </Header>

      <ColumnLayout columns={3} variant="text-grid">
        <Container header={<Header variant="h3">アクティブテナント</Header>}>
          <Box variant="awsui-key-label">現在稼働中のテナント数</Box>
          <Box variant="awsui-value-large">{stats?.activeTenants ?? '-'}</Box>
        </Container>

        <Container
          header={
            <Header
              variant="h3"
              info={
                stats?.systemStatus === 'healthy' ? (
                  <StatusIndicator type="success">正常</StatusIndicator>
                ) : (
                  <StatusIndicator type="error">異常</StatusIndicator>
                )
              }
            >
              システムステータス
            </Header>
          }
        >
          <Box variant="awsui-key-label">稼働率</Box>
          <Box variant="awsui-value-large">
            {stats?.uptimePercentage ?? '-'}%
          </Box>
        </Container>

        <Container header={<Header variant="h3">総テナント数</Header>}>
          <Box variant="awsui-key-label">登録済みテナント</Box>
          <Box variant="awsui-value-large">{stats?.totalTenants ?? '-'}</Box>
        </Container>
      </ColumnLayout>

      <Container
        header={
          <Header variant="h2" description="よく使う操作">
            クイックアクション
          </Header>
        }
      >
        <SpaceBetween direction="horizontal" size="l">
          <NextLink href="/dashboard/tenants">
            <Button>テナント管理</Button>
          </NextLink>
          <NextLink href="/dashboard/tenants/new">
            <Button>新規テナント作成</Button>
          </NextLink>
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header variant="h2" description="直近のシステムイベント">
            最近のアクティビティ
          </Header>
        }
      >
        {activities.length === 0 ? (
          <Box textAlign="center" color="text-body-secondary">
            アクティビティはありません
          </Box>
        ) : (
          <SpaceBetween size="xs">
            {activities.map((activity) => (
              <div
                key={activity.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom:
                    '1px solid var(--color-border-divider-default, #e9ebed)',
                }}
              >
                <Box>{formatActivityMessage(activity)}</Box>
                <Box color="text-body-secondary" fontSize="body-s">
                  {formatRelativeTime(activity.timestamp)}
                </Box>
              </div>
            ))}
          </SpaceBetween>
        )}
      </Container>
    </SpaceBetween>
  );
}
