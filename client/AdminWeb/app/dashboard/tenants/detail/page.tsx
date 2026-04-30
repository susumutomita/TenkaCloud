'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PlanCard } from '@/components/tenants/plan-card';
import { ProvisioningCard } from '@/components/tenants/provisioning-card';
import { TenantAccessCard } from '@/components/tenants/tenant-access-card';
import { TenantActions } from '@/components/tenants/tenant-actions';
import { tenantApi } from '@/lib/api/tenant-api';
import { useAuth } from '@/lib/auth/auth-context';
import type { Tenant } from '@/types/tenant';

export default function TenantDetailPage() {
  return (
    <Suspense fallback={<div className="p-6">読み込み中...</div>}>
      <TenantDetailInner />
    </Suspense>
  );
}

function TenantDetailInner() {
  const { session } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get('id');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!session || !id) return;
    void (async () => {
      try {
        setTenant(await tenantApi.getTenant(id));
      } catch {
        setTenant(null);
      } finally {
        setLoaded(true);
      }
    })();
  }, [session, id]);

  useEffect(() => {
    if (loaded && !tenant) {
      router.replace('/dashboard/tenants');
    }
  }, [loaded, tenant, router]);

  if (!session) return null;
  if (!id || !loaded) return <div className="p-6">読み込み中...</div>;
  if (!tenant) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {tenant.name}
          </h1>
          <p className="text-sm text-muted-foreground">ID: {tenant.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/tenants"
            className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            戻る
          </Link>
          <TenantActions tenantId={tenant.id} />
          <Link
            href={`/dashboard/tenants/edit?id=${encodeURIComponent(tenant.id)}`}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            編集
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm">
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="font-semibold leading-none tracking-tight">
              基本情報
            </h3>
          </div>
          <div className="p-6 pt-0">
            <dl className="grid gap-4">
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  ステータス
                </dt>
                <dd className="col-span-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                      tenant.status === 'ACTIVE'
                        ? 'bg-green-100 text-green-800'
                        : tenant.status === 'SUSPENDED'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {tenant.status}
                  </span>
                </dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  Tier
                </dt>
                <dd className="col-span-2 capitalize">{tenant.tier}</dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  Slug
                </dt>
                <dd className="col-span-2 font-mono text-sm">{tenant.slug}</dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  管理者 Email
                </dt>
                <dd className="col-span-2">{tenant.adminEmail}</dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  作成日時
                </dt>
                <dd className="col-span-2">
                  {new Date(tenant.createdAt).toLocaleString('ja-JP')}
                </dd>
              </div>
              <div className="grid grid-cols-3 items-center gap-4">
                <dt className="text-sm font-medium text-muted-foreground">
                  更新日時
                </dt>
                <dd className="col-span-2">
                  {new Date(tenant.updatedAt).toLocaleString('ja-JP')}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <ProvisioningCard tenant={tenant} />
      </div>

      <TenantAccessCard tenant={tenant} />

      <PlanCard tenant={tenant} />
    </div>
  );
}
