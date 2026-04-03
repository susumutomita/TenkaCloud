'use client';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantApi } from '@/lib/api/tenant-api';
import { TENANT_TIER_LABELS, TENANT_TIERS, TIER_FEATURES, type Tenant, type TenantTier } from '@/types/tenant';
interface PlanCardProps { tenant: Tenant; }
const tierOrder: Record<TenantTier, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };
function formatLimit(value: number): string { return value === -1 ? '無制限' : value + '名まで'; }
function formatBattleLimit(value: number): string { return value === -1 ? '無制限' : value + '回/月'; }
export function PlanCard({ tenant }: PlanCardProps) {
  const router = useRouter(); const [isLoading, setIsLoading] = useState(false); const [error, setError] = useState<string | null>(null); const [showDialog, setShowDialog] = useState(false); const [targetTier, setTargetTier] = useState<TenantTier | null>(null);
  const currentTierOrder = tierOrder[tenant.tier];
  const handleTierClick = (tier: TenantTier) => { setTargetTier(tier); setShowDialog(true); setError(null); };
  const handleConfirm = async () => { setIsLoading(true); setError(null); try { await tenantApi.updateTenant(tenant.id, { tier: targetTier! }); setShowDialog(false); router.refresh(); } catch (err) { setError(err instanceof Error ? err.message : 'プランの変更に失敗しました'); } finally { setIsLoading(false); } };
  const handleCancel = () => { setShowDialog(false); setTargetTier(null); };
  const isUpgrade = targetTier ? tierOrder[targetTier] > currentTierOrder : false;
  const requiresReprovisioning = targetTier && TIER_FEATURES[tenant.tier].isolationModel !== TIER_FEATURES[targetTier].isolationModel;
  return (<Container header={<Header variant="h2" description={'現在のプラン: ' + TENANT_TIER_LABELS[tenant.tier]}>プラン</Header>}><SpaceBetween size="m"><ColumnLayout columns={3} variant="default">{TENANT_TIERS.map((tier) => { const features = TIER_FEATURES[tier]; const isCurrent = tier === tenant.tier; const targetOrder = tierOrder[tier]; const actionLabel = targetOrder > currentTierOrder ? TENANT_TIER_LABELS[tier] + ' にアップグレード' : TENANT_TIER_LABELS[tier] + ' にダウングレード'; return (<div key={tier} data-testid={'plan-card-' + tier} style={{ padding: 16, borderRadius: 8, border: isCurrent ? '2px solid #0972d3' : '1px solid #e9ebed', background: isCurrent ? 'rgba(9,114,211,0.05)' : 'transparent' }}><SpaceBetween size="m"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><Box variant="h4">{TENANT_TIER_LABELS[tier]}</Box>{isCurrent && <Badge color="blue">現在のプラン</Badge>}</div><SpaceBetween size="xxs"><Box color="text-body-secondary">{formatLimit(features.maxParticipants)}</Box><Box color="text-body-secondary">{formatBattleLimit(features.maxBattles)}</Box>{features.apiAccess && <Box color="text-body-secondary">API アクセス</Box>}{features.ssoEnabled && <Box color="text-body-secondary">SSO 対応</Box>}{features.customBranding && <Box color="text-body-secondary">カスタムブランディング</Box>}<Box color="text-body-secondary">{features.isolationModel === 'SILO' ? '専用環境' : '共有環境'}</Box></SpaceBetween>{!isCurrent && <Button variant={targetOrder > currentTierOrder ? 'primary' : 'normal'} onClick={() => handleTierClick(tier)} fullWidth>{actionLabel}</Button>}</SpaceBetween></div>); })}</ColumnLayout>{error && <Alert type="error">{error}</Alert>}</SpaceBetween><Modal visible={showDialog && targetTier !== null} onDismiss={handleCancel} header="プランを変更しますか？" footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={handleCancel} disabled={isLoading}>キャンセル</Button><Button variant="primary" onClick={handleConfirm} loading={isLoading} disabled={isLoading}>{isLoading ? '処理中...' : '変更を確定'}</Button></SpaceBetween></Box>}><SpaceBetween size="m"><Box>{targetTier && TENANT_TIER_LABELS[tenant.tier] + ' \u2192 ' + TENANT_TIER_LABELS[targetTier] + ' に' + (isUpgrade ? 'アップグレード' : 'ダウングレード')}</Box>{requiresReprovisioning && <Alert type="warning">注意: 分離モデルが変更されるため、再プロビジョニングが必要です。一時的にサービスが停止します。</Alert>}</SpaceBetween></Modal></Container>);
}
