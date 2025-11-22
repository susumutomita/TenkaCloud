import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Control Plane Dashboard
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              ようこそ、{session.user.name || session.user.email} さん
            </p>
          </div>

          <form
            action={async () => {
              'use server';
              const currentSession = await auth();

              // signOut実行前にidTokenを保存
              const idToken = currentSession?.idToken;
              const keycloakIssuer = process.env.AUTH_KEYCLOAK_ISSUER;

              await signOut({ redirect: false });

              if (idToken && keycloakIssuer) {
                const logoutUrl = `${keycloakIssuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(
                  'http://localhost:3000'
                )}&id_token_hint=${idToken}`;
                redirect(logoutUrl);
              } else {
                redirect('/login');
              }
            }}
          >
            <Button type="submit" variant="destructive">
              ログアウト
            </Button>
          </form>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-6 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                アクティブテナント
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-muted-foreground">現在のテナント数</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                実行中のバトル
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
              <p className="text-xs text-muted-foreground">現在のバトル数</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                システムステータス
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Badge variant="success">正常</Badge>
              <p className="mt-2 text-xs text-muted-foreground">
                全サービス稼働中
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>クイックアクション</CardTitle>
            <CardDescription>
              よく使う機能に素早くアクセスできます
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
            <Button variant="outline" className="w-full" disabled>
              バトル管理（準備中）
            </Button>
            <Button variant="outline" className="w-full" disabled>
              ユーザー管理（準備中）
            </Button>
            <Button variant="outline" className="w-full" disabled>
              システム設定（準備中）
            </Button>
            <Button variant="outline" className="w-full" disabled>
              監視ダッシュボード（準備中）
            </Button>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>最近のアクティビティ</CardTitle>
            <CardDescription>
              プラットフォーム全体の最新アクティビティ
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                アクティビティはまだありません
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
