import Link from 'next/link';
import { TenantList } from '@/components/tenants/tenant-list';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { tenantApi } from '@/lib/api/tenant-api';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

export default async function TenantsPage() {
  const tenants = await tenantApi.listTenants();

  const total = tenants.length;
  const activeCount = tenants.filter((t) => t.status === 'ACTIVE').length;
  const suspendedCount = tenants.filter((t) => t.status === 'SUSPENDED').length;
  const enterpriseCount = tenants.filter((t) => t.tier === 'ENTERPRISE').length;

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
              テナントの作成・管理を行います。
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

      {/* Tenants Table with Search/Filter */}
      <Card>
        <CardHeader>
          <CardTitle>テナント一覧</CardTitle>
          <CardDescription>
            テナントの検索・フィルタリングができます
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TenantList tenants={tenants} />
        </CardContent>
      </Card>
    </div>
  );
}
