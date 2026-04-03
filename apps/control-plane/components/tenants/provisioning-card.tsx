'use client';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant } from '@/types/tenant';
type ProvisioningStatus = Tenant['provisioningStatus'];
const statusLabels: Record<ProvisioningStatus, string> = { PENDING: '未プロビジョニング', IN_PROGRESS: 'プロビジョニング中', COMPLETED: 'プロビジョニング完了', FAILED: 'プロビジョニング失敗' };
function getProvisioningStatusType(status: ProvisioningStatus): 'pending' | 'in-progress' | 'success' | 'error' { switch (status) { case 'PENDING': return 'pending'; case 'IN_PROGRESS': return 'in-progress'; case 'COMPLETED': return 'success'; case 'FAILED': return 'error'; } }
interface ProvisioningCardProps { tenant: Tenant; }
export function ProvisioningCard({ tenant }: ProvisioningCardProps) {
  const router = useRouter(); const [isLoading, setIsLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const canProvision = tenant.provisioningStatus === 'PENDING' || tenant.provisioningStatus === 'FAILED';
  const handleProvision = async () => { setIsLoading(true); setError(null); try { await tenantApi.triggerProvisioning(tenant.id); router.refresh(); } catch (err) { setError(err instanceof Error ? err.message : 'プロビジョニングに失敗しました'); } finally { setIsLoading(false); } };
  return (<Container header={<Header variant="h2">プロビジョニング</Header>}><SpaceBetween size="m"><KeyValuePairs columns={1} items={[{ label: 'ステータス', value: <StatusIndicator type={getProvisioningStatusType(tenant.provisioningStatus)}>{statusLabels[tenant.provisioningStatus]}</StatusIndicator> },{ label: 'リージョン', value: tenant.region },{ label: '分離モデル', value: tenant.isolationModel },{ label: 'コンピュートタイプ', value: tenant.computeType }]} />{error && <Alert type="error">{error}</Alert>}{canProvision && <Button variant="primary" onClick={handleProvision} loading={isLoading} disabled={isLoading}>{isLoading ? 'プロビジョニング中...' : tenant.provisioningStatus === 'FAILED' ? '再試行' : 'プロビジョニング開始'}</Button>}</SpaceBetween></Container>);
}
