'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { tenantApi } from '@/lib/api/tenant-api';
import type { TenantTier } from '@/types/tenant';
import { TENANT_TIER_LABELS, TENANT_TIERS } from '@/types/tenant';

export default function NewTenantPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    adminEmail: '',
    tier: 'FREE' as TenantTier,
  });
  // ユーザーが手動でスラッグを編集したかどうかを追跡
  const isSlugManuallyEdited = useRef(false);

  // テナント名からスラッグを自動生成
  const generateSlug = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 63);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await tenantApi.createTenant(formData);
      router.push('/dashboard/tenants');
      router.refresh(); // 一覧データを更新
    } catch (error) {
      console.error('Failed to create tenant:', error);
      alert('テナント作成に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">新規テナント作成</h1>
      </div>

      <div className="rounded-xl border bg-card text-card-foreground shadow max-w-2xl">
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="font-semibold leading-none tracking-tight">
              テナント情報
            </h3>
            <p className="text-sm text-muted-foreground text-gray-500">
              新しいテナントを作成します。
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
                placeholder="例: 株式会社Acme"
                value={formData.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setFormData({
                    ...formData,
                    name,
                    // ユーザーが手動で編集していない場合のみスラッグを自動生成
                    slug: isSlugManuallyEdited.current
                      ? formData.slug
                      : generateSlug(name),
                  });
                }}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="slug"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                スラッグ（URL識別子）
              </label>
              <input
                id="slug"
                required
                pattern="^[a-z0-9-]+$"
                minLength={3}
                maxLength={63}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-300"
                placeholder="例: acme-corp"
                value={formData.slug}
                onChange={(e) => {
                  isSlugManuallyEdited.current = true;
                  setFormData({ ...formData, slug: e.target.value });
                }}
              />
              <p className="text-xs text-gray-500">
                小文字英数字とハイフンのみ（3〜63文字）
              </p>
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
                placeholder="admin@example.com"
                value={formData.adminEmail}
                onChange={(e) =>
                  setFormData({ ...formData, adminEmail: e.target.value })
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
                  setFormData({
                    ...formData,
                    tier: e.target.value as TenantTier,
                  })
                }
              >
                {TENANT_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {TENANT_TIER_LABELS[tier]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center p-6 pt-0 space-x-2">
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-black text-white"
            >
              {isLoading ? '作成中...' : '作成'}
            </button>
            <Link
              href="/dashboard/tenants"
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
