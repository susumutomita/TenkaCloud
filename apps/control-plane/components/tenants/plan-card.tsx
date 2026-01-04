'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantApi } from '@/lib/api/tenant-api';
import {
  TENANT_TIER_LABELS,
  TENANT_TIERS,
  TIER_FEATURES,
  type Tenant,
  type TenantTier,
} from '@/types/tenant';

interface PlanCardProps {
  tenant: Tenant;
}

const tierOrder: Record<TenantTier, number> = {
  FREE: 0,
  PRO: 1,
  ENTERPRISE: 2,
};

function formatLimit(value: number): string {
  return value === -1 ? '無制限' : `${value}名まで`;
}

function formatBattleLimit(value: number): string {
  return value === -1 ? '無制限' : `${value}回/月`;
}

export function PlanCard({ tenant }: PlanCardProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [targetTier, setTargetTier] = useState<TenantTier | null>(null);

  const currentTierOrder = tierOrder[tenant.tier];

  const handleTierClick = (tier: TenantTier) => {
    setTargetTier(tier);
    setShowDialog(true);
    setError(null);
  };

  const handleConfirm = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await tenantApi.updateTenant(tenant.id, { tier: targetTier! });
      setShowDialog(false);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'プランの変更に失敗しました'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setShowDialog(false);
    setTargetTier(null);
  };

  const isUpgrade = targetTier
    ? tierOrder[targetTier] > currentTierOrder
    : false;
  const requiresReprovisioning =
    targetTier &&
    TIER_FEATURES[tenant.tier].isolationModel !==
      TIER_FEATURES[targetTier].isolationModel;

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="font-semibold leading-none tracking-tight">プラン</h3>
        <p className="text-sm text-muted-foreground">
          現在のプラン: {TENANT_TIER_LABELS[tenant.tier]}
        </p>
      </div>
      <div className="p-6 pt-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TENANT_TIERS.map((tier) => {
            const features = TIER_FEATURES[tier];
            const isCurrent = tier === tenant.tier;
            const targetOrder = tierOrder[tier];
            const actionLabel =
              targetOrder > currentTierOrder
                ? `${TENANT_TIER_LABELS[tier]} にアップグレード`
                : `${TENANT_TIER_LABELS[tier]} にダウングレード`;

            return (
              <div
                key={tier}
                data-testid={`plan-card-${tier}`}
                className={`rounded-lg border p-4 ${
                  isCurrent
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500'
                    : 'border-gray-200'
                }`}
              >
                <div className="mb-4 flex items-center justify-between">
                  <h4 className="font-semibold">{TENANT_TIER_LABELS[tier]}</h4>
                  {isCurrent && (
                    <span className="rounded-full bg-blue-500 px-2 py-1 text-xs text-white">
                      現在のプラン
                    </span>
                  )}
                </div>

                <ul className="mb-4 space-y-2 text-sm text-gray-600">
                  <li>{formatLimit(features.maxParticipants)}</li>
                  <li>{formatBattleLimit(features.maxBattles)}</li>
                  {features.apiAccess && <li>API アクセス</li>}
                  {features.ssoEnabled && <li>SSO 対応</li>}
                  {features.customBranding && <li>カスタムブランディング</li>}
                  <li>
                    {features.isolationModel === 'SILO'
                      ? '専用環境'
                      : '共有環境'}
                  </li>
                </ul>

                {!isCurrent && (
                  <button
                    type="button"
                    onClick={() => handleTierClick(tier)}
                    className={`w-full rounded-md px-3 py-2 text-sm font-medium ${
                      targetOrder > currentTierOrder
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {actionLabel}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {showDialog && targetTier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">
              プランを変更しますか？
            </h3>

            <p className="mb-4 text-sm text-gray-600">
              {TENANT_TIER_LABELS[tenant.tier]} →{' '}
              {TENANT_TIER_LABELS[targetTier]} に
              {isUpgrade ? 'アップグレード' : 'ダウングレード'}
            </p>

            {requiresReprovisioning && (
              <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-700">
                <strong>注意:</strong>{' '}
                分離モデルが変更されるため、再プロビジョニングが必要です。一時的にサービスが停止します。
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCancel}
                disabled={isLoading}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={isLoading}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isLoading ? '処理中...' : '変更を確定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
