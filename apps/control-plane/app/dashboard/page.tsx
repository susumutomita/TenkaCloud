import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const [stats, activities] = await Promise.all([getStats(), getActivities()]);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">ダッシュボード</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ようこそ、{session.user.name || session.user.email} さん
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              アクティブテナント
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.activeTenants ?? '-'}
            </div>
            <p className="text-xs text-muted-foreground">
              現在稼働中のテナント数
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              システムステータス
            </CardTitle>
            <Badge
              variant={
                stats?.systemStatus === 'healthy' ? 'success' : 'destructive'
              }
            >
              {stats?.systemStatus === 'healthy' ? '正常' : '異常'}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.uptimePercentage ?? '-'}%
            </div>
            <p className="text-xs text-muted-foreground">稼働率</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">総テナント数</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.totalTenants ?? '-'}
            </div>
            <p className="text-xs text-muted-foreground">登録済みテナント</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>クイックアクション</CardTitle>
          <CardDescription>よく使う操作</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Link href="/dashboard/tenants">
            <Button variant="outline" className="w-full">
              テナント管理
            </Button>
          </Link>
          <Link href="/dashboard/tenants/new">
            <Button variant="outline" className="w-full">
              新規テナント作成
            </Button>
          </Link>
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>最近のアクティビティ</CardTitle>
          <CardDescription>直近のシステムイベント</CardDescription>
        </CardHeader>
        <CardContent>
          {activities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              アクティビティはありません
            </p>
          ) : (
            <ul className="space-y-3">
              {activities.map((activity) => (
                <li
                  key={activity.id}
                  className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0"
                >
                  <span className="text-sm">
                    {formatActivityMessage(activity)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(activity.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
