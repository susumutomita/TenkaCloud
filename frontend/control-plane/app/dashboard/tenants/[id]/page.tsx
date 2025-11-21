import Link from 'next/link';
import { notFound } from 'next/navigation';
import { mockTenantApi } from '@/lib/api/mock-tenant-api';
import { TenantActions } from '@/components/tenants/tenant-actions';

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenant = await mockTenantApi.getTenant(id);

  if (!tenant) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">{tenant.name}</h1>
          <p className="text-muted-foreground text-gray-500">ID: {tenant.id}</p>
        </div>
        <div className="flex space-x-2">
          <Link
            href="/dashboard/tenants"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            戻る
          </Link>
          <TenantActions tenantId={tenant.id} />
          <Link
            href={`/dashboard/tenants/${tenant.id}/edit`}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-black text-white"
          >
            編集
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="font-semibold leading-none tracking-tight">
              基本情報
            </h3>
          </div>
          <div className="p-6 pt-0">
            <dl className="grid gap-4">
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="font-medium text-sm text-gray-500">
                  ステータス
                </dt>
                <dd className="col-span-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                      tenant.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : tenant.status === 'suspended'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {tenant.status}
                  </span>
                </dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="font-medium text-sm text-gray-500">Tier</dt>
                <dd className="col-span-2 capitalize">{tenant.tier}</dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="font-medium text-sm text-gray-500">
                  管理者 Email
                </dt>
                <dd className="col-span-2">{tenant.adminEmail}</dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="font-medium text-sm text-gray-500">作成日時</dt>
                <dd className="col-span-2">
                  {new Date(tenant.createdAt).toLocaleString('ja-JP')}
                </dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="font-medium text-sm text-gray-500">更新日時</dt>
                <dd className="col-span-2">
                  {new Date(tenant.updatedAt).toLocaleString('ja-JP')}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="font-semibold leading-none tracking-tight">
              リソース使用状況 (Mock)
            </h3>
          </div>
          <div className="p-6 pt-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">CPU 使用率</span>
                  <span className="text-muted-foreground">45%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-secondary bg-gray-100">
                  <div
                    className="h-full rounded-full bg-primary bg-black"
                    style={{ width: '45%' }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">メモリ 使用率</span>
                  <span className="text-muted-foreground">62%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-secondary bg-gray-100">
                  <div
                    className="h-full rounded-full bg-primary bg-black"
                    style={{ width: '62%' }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">ストレージ 使用率</span>
                  <span className="text-muted-foreground">28%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-secondary bg-gray-100">
                  <div
                    className="h-full rounded-full bg-primary bg-black"
                    style={{ width: '28%' }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
