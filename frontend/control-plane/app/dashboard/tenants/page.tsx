import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tenantApi } from '@/lib/api/tenant-api';

const getStatusVariant = (status: string) => {
  if (status === 'active') return 'success';
  if (status === 'suspended') return 'warning';
  return 'error';
};

export default async function TenantsPage() {
  const tenants = await tenantApi.listTenants();

  const total = tenants.length;
  const activeCount = tenants.filter((t) => t.status === 'active').length;
  const suspendedCount = tenants.filter((t) => t.status === 'suspended').length;
  const enterpriseCount = tenants.filter((t) => t.tier === 'enterprise').length;

  return (
    <div className="space-y-8 p-8">
      {/* Header Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Control Plane
            </p>
            <h1 className="text-3xl font-bold tracking-tight">テナント管理</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              環境変数 TENANT_API_BASE_URL を設定すると実 API
              へ接続し、未設定の場合はモックデータでプレビューします。
            </p>
          </div>
          <div className="flex gap-3">
            <Link href="/dashboard/tenants/new">
              <Button>新規テナントを作成</Button>
            </Link>
            <Link href="/docs/architecture">
              <Button variant="outline">設計ドキュメント</Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-6 md:grid-cols-4">
        {[
          { label: '総テナント', value: total },
          { label: '稼働中', value: activeCount },
          { label: '一時停止', value: suspendedCount },
          { label: 'Enterprise', value: enterpriseCount },
        ].map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardDescription className="text-xs uppercase tracking-wide">
                {item.label}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tenants Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>テナント一覧</CardTitle>
              <CardDescription>現在 {total} 件を表示中</CardDescription>
            </div>
            <p className="text-xs text-muted-foreground">
              接続先:{' '}
              {process.env.NEXT_PUBLIC_TENANT_API_BASE_URL ||
                'モック (ローカルデータ)'}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                テナントがまだ登録されていません
              </p>
              <Link href="/dashboard/tenants/new">
                <Button variant="outline" className="mt-4">
                  最初のテナントを作成
                </Button>
              </Link>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>テナント</TableHead>
                  <TableHead>ステータス</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>管理者 Email</TableHead>
                  <TableHead>作成日</TableHead>
                  <TableHead className="text-right">アクション</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Link
                          href={`/dashboard/tenants/${tenant.id}`}
                          className="font-semibold hover:underline"
                        >
                          {tenant.name}
                        </Link>
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          ID: {tenant.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusVariant(tenant.status)}>
                        {tenant.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {tenant.tier}
                      </Badge>
                    </TableCell>
                    <TableCell>{tenant.adminEmail}</TableCell>
                    <TableCell>
                      {new Date(tenant.createdAt).toLocaleDateString('ja-JP')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/dashboard/tenants/${tenant.id}`}>
                          <Button variant="ghost" size="sm">
                            詳細
                          </Button>
                        </Link>
                        <Link href={`/dashboard/tenants/${tenant.id}/edit`}>
                          <Button variant="ghost" size="sm">
                            編集
                          </Button>
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
