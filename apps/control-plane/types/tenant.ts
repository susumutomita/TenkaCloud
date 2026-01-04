export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type TenantTier = 'FREE' | 'PRO' | 'ENTERPRISE';

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

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  tier: TenantTier;
}

export interface UpdateTenantInput {
  name?: string;
  adminEmail?: string;
  status?: TenantStatus;
  tier?: TenantTier;
}
