'use client';

import { useState } from 'react';
import type { Tenant } from '@/types/tenant';

interface TenantAccessCardProps {
  tenant: Tenant;
  onCopyUrl?: (url: string) => Promise<void>;
}

export function getApplicationPlaneUrl(slug: string): string {
  return `https://${slug}.tenka.cloud`;
}

export async function defaultCopyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function TenantAccessCard({
  tenant,
  onCopyUrl = defaultCopyToClipboard,
}: TenantAccessCardProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>(
    'idle'
  );

  const applicationPlaneUrl = getApplicationPlaneUrl(tenant.slug);
  const isProvisioningComplete = tenant.provisioningStatus === 'COMPLETED';
  const isProvisioningInProgress =
    tenant.provisioningStatus === 'PENDING' ||
    tenant.provisioningStatus === 'IN_PROGRESS';
  const isProvisioningFailed = tenant.provisioningStatus === 'FAILED';

  const handleCopyUrl = async () => {
    try {
      await onCopyUrl(applicationPlaneUrl);
      setCopyStatus('success');
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('idle'), 2000);
    }
  };

  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow">
      <div className="flex flex-col space-y-1.5 p-6">
        <h3 className="font-semibold leading-none tracking-tight">
          テナント管理画面
        </h3>
        <p className="text-sm text-muted-foreground">
          このテナントの Application Plane にアクセスします
        </p>
      </div>
      <div className="p-6 pt-0">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="mb-3">
            <span className="text-sm text-gray-500">URL:</span>
            <p className="font-mono text-sm">{applicationPlaneUrl}</p>
          </div>

          {isProvisioningInProgress && (
            <div className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-700">
              プロビジョニング中です。完了までお待ちください。
            </div>
          )}

          {isProvisioningFailed && (
            <div className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
              プロビジョニング失敗。管理者にお問い合わせください。
            </div>
          )}

          <div className="flex gap-3">
            <a
              href={applicationPlaneUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!isProvisioningComplete}
              className={`inline-flex items-center rounded-md px-4 py-2 text-sm font-medium ${
                isProvisioningComplete
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'pointer-events-none cursor-not-allowed bg-gray-300 text-gray-500'
              }`}
            >
              管理画面を開く
              <svg
                className="ml-2 h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </a>

            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {copyStatus === 'success' ? (
                <>
                  <svg
                    className="mr-2 h-4 w-4 text-green-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  コピーしました
                </>
              ) : copyStatus === 'error' ? (
                <>
                  <svg
                    className="mr-2 h-4 w-4 text-red-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                  コピーに失敗しました
                </>
              ) : (
                <>
                  <svg
                    className="mr-2 h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                  URLをコピー
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
