import Link from 'next/link';
import { mockTenantApi } from '@/lib/api/mock-tenant-api';

export default async function TenantsPage() {
  const tenants = await mockTenantApi.listTenants();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">テナント管理</h1>
        <Link
          href="/dashboard/tenants/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-black text-white"
        >
          新規作成
        </Link>
      </div>

      <div className="rounded-md border">
        <div className="relative w-full overflow-auto">
          <table className="w-full caption-bottom text-sm">
            <thead className="[&_tr]:border-b">
              <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  名前
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  ステータス
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  Tier
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  管理者 Email
                </th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                  作成日
                </th>
                <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">
                  アクション
                </th>
              </tr>
            </thead>
            <tbody className="[&_tr:last-child]:border-0">
              {tenants.map((tenant) => (
                <tr
                  key={tenant.id}
                  className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted"
                >
                  <td className="p-4 align-middle font-medium">
                    <Link
                      href={`/dashboard/tenants/${tenant.id}`}
                      className="hover:underline"
                    >
                      {tenant.name}
                    </Link>
                  </td>
                  <td className="p-4 align-middle">
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
                  </td>
                  <td className="p-4 align-middle capitalize">{tenant.tier}</td>
                  <td className="p-4 align-middle">{tenant.adminEmail}</td>
                  <td className="p-4 align-middle">
                    {new Date(tenant.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="p-4 align-middle text-right">
                    <Link
                      href={`/dashboard/tenants/${tenant.id}`}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      詳細
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
