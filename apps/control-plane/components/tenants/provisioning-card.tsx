'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant } from '@/types/tenant';

type ProvisioningStatus = Tenant['provisioningStatus'];

const statusLabels: Record<ProvisioningStatus, string> = {
  PENDING: '未プロビジョニング',
  IN_PROGRESS: 'プロビジョニング中',
  COMPLETED: 'プロビジョニング完了',
  FAILED: 'プロビジョニング失敗',
};

const statusColors: Record<ProvisioningStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

interface ProvisioningCardProps {
  tenant: Tenant;
}

export function ProvisioningCard({ tenant }: ProvisioningCardProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canProvision =
    tenant.provisioningStatus === 'PENDING' ||
    tenant.provisioningStatus === 'FAILED';

  const handleProvision = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await tenantApi.triggerProvisioning(tenant.id);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'プロビジョニングに失敗しました'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="font-semibold leading-none tracking-tight">
          プロビジョニング
        </h3>
      </div>
      <div className="p-6 pt-0">
        <dl className="grid gap-4">
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="font-medium text-sm text-gray-500">ステータス</dt>
            <dd className="col-span-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusColors[tenant.provisioningStatus]}`}
              >
                {statusLabels[tenant.provisioningStatus]}
              </span>
            </dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="font-medium text-sm text-gray-500">リージョン</dt>
            <dd className="col-span-2">{tenant.region}</dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="font-medium text-sm text-gray-500">分離モデル</dt>
            <dd className="col-span-2">{tenant.isolationModel}</dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="font-medium text-sm text-gray-500">
              コンピュートタイプ
            </dt>
            <dd className="col-span-2">{tenant.computeType}</dd>
          </div>
        </dl>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {canProvision && (
          <div className="mt-4">
            <button
              type="button"
              onClick={handleProvision}
              disabled={isLoading}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-blue-600 text-white hover:bg-blue-700"
            >
              {isLoading
                ? 'プロビジョニング中...'
                : tenant.provisioningStatus === 'FAILED'
                  ? '再試行'
                  : 'プロビジョニング開始'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
