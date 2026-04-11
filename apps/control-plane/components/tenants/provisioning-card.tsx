'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantApi } from '@/lib/api/tenant-api';
import type { ApplicationDeploymentStatus, Tenant } from '@/types/tenant';

type ProvisioningStatus = Tenant['provisioningStatus'];

const statusLabels: Record<ProvisioningStatus, string> = {
  PENDING: '未プロビジョニング',
  IN_PROGRESS: 'プロビジョニング中',
  COMPLETED: 'プロビジョニング完了',
  FAILED: 'プロビジョニング失敗',
};

const statusColors: Record<ProvisioningStatus, string> = {
  PENDING: 'border border-border bg-muted text-muted-foreground',
  IN_PROGRESS:
    'border border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  COMPLETED:
    'border border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  FAILED:
    'border border-rose-500/20 bg-rose-500/10 text-rose-800 dark:text-rose-300',
};

const applicationStatusLabels: Record<ApplicationDeploymentStatus, string> = {
  NOT_DEPLOYED: '未デプロイ',
  DEPLOYING: 'デプロイ中',
  DEPLOYED: 'デプロイ済み',
  FAILED: 'デプロイ失敗',
};

const applicationStatusColors: Record<ApplicationDeploymentStatus, string> = {
  NOT_DEPLOYED:
    'border border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  DEPLOYING:
    'border border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  DEPLOYED:
    'border border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  FAILED:
    'border border-rose-500/20 bg-rose-500/10 text-rose-800 dark:text-rose-300',
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
  const applicationDeploymentStatus =
    tenant.applicationDeploymentStatus ?? 'NOT_DEPLOYED';

  const handleProvision = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await tenantApi.triggerProvisioning(tenant.id);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'プロビジョニングに失敗しました',
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="font-semibold leading-none tracking-tight">
          プロビジョニング
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
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusColors[tenant.provisioningStatus]}`}
              >
                {statusLabels[tenant.provisioningStatus]}
              </span>
            </dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="text-sm font-medium text-muted-foreground">
              Application Plane
            </dt>
            <dd className="col-span-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${applicationStatusColors[applicationDeploymentStatus]}`}
              >
                {applicationStatusLabels[applicationDeploymentStatus]}
              </span>
            </dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="text-sm font-medium text-muted-foreground">
              リージョン
            </dt>
            <dd className="col-span-2">{tenant.region}</dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="text-sm font-medium text-muted-foreground">
              分離モデル
            </dt>
            <dd className="col-span-2">{tenant.isolationModel}</dd>
          </div>
          <div className="grid grid-cols-3 items-center gap-4">
            <dt className="text-sm font-medium text-muted-foreground">
              コンピュートタイプ
            </dt>
            <dd className="col-span-2">{tenant.computeType}</dd>
          </div>
        </dl>

        {applicationDeploymentStatus === 'NOT_DEPLOYED' ? (
          <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
            現在のプロビジョニングでは基盤リソースのみが作成されています。Application
            Plane bundle はまだ配備されていません。
          </div>
        ) : null}

        {tenant.provisionedResources ? (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
            <div className="text-sm font-medium text-foreground">
              作成済みリソース
            </div>
            <dl className="mt-3 grid gap-2 text-sm">
              {tenant.provisionedResources.s3Bucket ? (
                <div className="grid grid-cols-3 gap-3">
                  <dt className="text-muted-foreground">S3 Bucket</dt>
                  <dd className="col-span-2 break-all">
                    {tenant.provisionedResources.s3Bucket}
                  </dd>
                </div>
              ) : null}
              {tenant.provisionedResources.s3Prefix ? (
                <div className="grid grid-cols-3 gap-3">
                  <dt className="text-muted-foreground">S3 Prefix</dt>
                  <dd className="col-span-2 break-all">
                    {tenant.provisionedResources.s3Prefix}
                  </dd>
                </div>
              ) : null}
              {tenant.provisionedResources.iamRoleArn ? (
                <div className="grid grid-cols-3 gap-3">
                  <dt className="text-muted-foreground">IAM Role</dt>
                  <dd className="col-span-2 break-all">
                    {tenant.provisionedResources.iamRoleArn}
                  </dd>
                </div>
              ) : null}
              {tenant.provisionedResources.cloudwatchLogGroup ? (
                <div className="grid grid-cols-3 gap-3">
                  <dt className="text-muted-foreground">CloudWatch</dt>
                  <dd className="col-span-2 break-all">
                    {tenant.provisionedResources.cloudwatchLogGroup}
                  </dd>
                </div>
              ) : null}
              {tenant.provisionedResources.auth0OrganizationId ? (
                <div className="grid grid-cols-3 gap-3">
                  <dt className="text-muted-foreground">Auth0 Org</dt>
                  <dd className="col-span-2 break-all">
                    {tenant.provisionedResources.auth0OrganizationId}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

        {tenant.provisioningError ? (
          <div className="mt-4 rounded-md border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-300">
            {tenant.provisioningError}
          </div>
        ) : null}

        {error && (
          <div className="mt-4 rounded-md border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-300">
            {error}
          </div>
        )}

        {canProvision && (
          <div className="mt-4">
            <button
              type="button"
              onClick={handleProvision}
              disabled={isLoading}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
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
