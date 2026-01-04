export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type TenantTier = 'FREE' | 'PRO' | 'ENTERPRISE';
export type ProvisioningStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED';
export type IsolationModel = 'POOL' | 'SILO';
export type ComputeType = 'SERVERLESS' | 'KUBERNETES';

export const TENANT_STATUSES: readonly TenantStatus[] = [
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;

export const TENANT_TIERS: readonly TenantTier[] = [
  'FREE',
  'PRO',
  'ENTERPRISE',
] as const;

export const PROVISIONING_STATUSES: readonly ProvisioningStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
] as const;

export const ISOLATION_MODELS: readonly IsolationModel[] = [
  'POOL',
  'SILO',
] as const;

export const COMPUTE_TYPES: readonly ComputeType[] = [
  'SERVERLESS',
  'KUBERNETES',
] as const;

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  ARCHIVED: 'Archived',
};

export const TENANT_TIER_LABELS: Record<TenantTier, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

export const PROVISIONING_STATUS_LABELS: Record<ProvisioningStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const ISOLATION_MODEL_LABELS: Record<IsolationModel, string> = {
  POOL: 'Pool（共有）',
  SILO: 'Silo（専有）',
};

export const COMPUTE_TYPE_LABELS: Record<ComputeType, string> = {
  SERVERLESS: 'Serverless',
  KUBERNETES: 'Kubernetes',
};

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  adminName?: string;
  region: string;
  isolationModel: IsolationModel;
  computeType: ComputeType;
  provisioningStatus: ProvisioningStatus;
  auth0OrgId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminName?: string;
  tier: TenantTier;
  region?: string;
  isolationModel?: IsolationModel;
  computeType?: ComputeType;
}

export interface UpdateTenantInput {
  name?: string;
  adminEmail?: string;
  status?: TenantStatus;
  tier?: TenantTier;
}
