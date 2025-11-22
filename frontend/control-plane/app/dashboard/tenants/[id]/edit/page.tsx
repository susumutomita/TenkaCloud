'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant, TenantTier } from '@/types/tenant';

export default function EditTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [formData, setFormData] = useState({
    name: '',
    adminEmail: '',
    tier: 'free' as TenantTier,
    status: 'active' as Tenant['status'],
  });

  // Next.js 15 では params が Promise で渡ってくるため、クライアント側で解決する
  useEffect(() => {
    let active = true;
    params
      .then(({ id }) => {
        if (!active) return;
        setId(id);
      })
      .catch((error) => {
        console.error('Failed to resolve params:', error);
        alert('パラメータの取得に失敗しました');
        setIsFetching(false);
      });

    return () => {
      active = false;
    };
  }, [params]);

  useEffect(() => {
    if (!id) return;

    const fetchTenant = async () => {
      try {
        const tenant = await tenantApi.getTenant(id);
        if (tenant) {
          setFormData({
            name: tenant.name,
            adminEmail: tenant.adminEmail,
            tier: tenant.tier,
            status: tenant.status,
          });
        } else {
          alert('テナントが見つかりません');
          router.push('/dashboard/tenants');
        }
      } catch (error) {
        console.error('Failed to fetch tenant:', error);
        alert('テナント情報の取得に失敗しました');
      } finally {
        setIsFetching(false);
      }
    };

    fetchTenant();
    // router オブジェクトはレンダーごとに新しくなる場合があるため依存配列には含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router.push]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!id) {
      return;
    }

    setIsLoading(true);

    try {
      await tenantApi.updateTenant(id, formData);
      router.push(`/dashboard/tenants/${id}`);
      router.refresh();
    } catch (error) {
      console.error('Failed to update tenant:', error);
      alert('テナント更新に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  if (!id || isFetching) {
    return <div className="p-6">読み込み中...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">テナント編集</h1>
      </div>

      <div className="rounded-xl border bg-card text-card-foreground shadow max-w-2xl">
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="font-semibold leading-none tracking-tight">
              テナント情報
            </h3>
            <p className="text-sm text-muted-foreground text-gray-500">
              テナント情報を編集します。
            </p>
          </div>
          <div className="p-6 pt-0 space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                テナント名
              </label>
              <input
                id="name"
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-300"
                value={formData.name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                管理者 Email
              </label>
              <input
                id="email"
                type="email"
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-300"
                value={formData.adminEmail}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    adminEmail: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="tier"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Tier
              </label>
              <select
                id="tier"
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-300"
                value={formData.tier}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    tier: e.target.value as TenantTier,
                  }))
                }
              >
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
            <div className="space-y-2">
              <label
                htmlFor="status"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                ステータス
              </label>
              <select
                id="status"
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-300"
                value={formData.status}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    status: e.target.value as Tenant['status'],
                  }))
                }
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="deleted">Deleted</option>
              </select>
            </div>
          </div>
          <div className="flex items-center p-6 pt-0 space-x-2">
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-black text-white"
            >
              {isLoading ? '更新中...' : '更新'}
            </button>
            <Link
              href={`/dashboard/tenants/${id}`}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              キャンセル
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
