'use client';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useState } from 'react';
import type { Tenant } from '@/types/tenant';
interface TenantAccessCardProps { tenant: Tenant; onCopyUrl?: (url: string) => Promise<void>; }
export function getApplicationPlaneUrl(slug: string): string { const localUrl = process.env.NEXT_PUBLIC_APPLICATION_PLANE_URL; if (localUrl) { return localUrl; } return 'https://' + slug + '.tenka.cloud'; }
export async function defaultCopyToClipboard(text: string): Promise<void> { await navigator.clipboard.writeText(text); }
export function TenantAccessCard({ tenant, onCopyUrl = defaultCopyToClipboard }: TenantAccessCardProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const applicationPlaneUrl = getApplicationPlaneUrl(tenant.slug);
  const isProvisioningComplete = tenant.provisioningStatus === 'COMPLETED';
  const isProvisioningInProgress = tenant.provisioningStatus === 'PENDING' || tenant.provisioningStatus === 'IN_PROGRESS';
  const isProvisioningFailed = tenant.provisioningStatus === 'FAILED';
  const handleCopyUrl = async () => { try { await onCopyUrl(applicationPlaneUrl); setCopyStatus('success'); setTimeout(() => setCopyStatus('idle'), 2000); } catch { setCopyStatus('error'); setTimeout(() => setCopyStatus('idle'), 2000); } };
  return (<Container header={<Header variant="h2" description="このテナントの Application Plane にアクセスします">テナント管理画面</Header>}><SpaceBetween size="m"><div><Box variant="small" color="text-body-secondary">URL:</Box><Box variant="code">{applicationPlaneUrl}</Box></div>{isProvisioningInProgress && <Alert type="warning">プロビジョニング中です。完了までお待ちください。</Alert>}{isProvisioningFailed && <Alert type="error">プロビジョニング失敗。管理者にお問い合わせください。</Alert>}<SpaceBetween direction="horizontal" size="xs"><a href={applicationPlaneUrl} target="_blank" rel="noopener noreferrer" aria-disabled={!isProvisioningComplete} style={{ pointerEvents: isProvisioningComplete ? 'auto' : 'none' }}><Button variant="primary" disabled={!isProvisioningComplete} iconName="external">管理画面を開く</Button></a><Button variant="normal" onClick={handleCopyUrl} iconName={copyStatus === 'success' ? 'status-positive' : copyStatus === 'error' ? 'status-negative' : 'copy'}>{copyStatus === 'success' ? 'コピーしました' : copyStatus === 'error' ? 'コピーに失敗しました' : 'URLをコピー'}</Button></SpaceBetween></SpaceBetween></Container>);
}
