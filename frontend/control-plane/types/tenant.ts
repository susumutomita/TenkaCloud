export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type TenantTier = 'FREE' | 'PRO' | 'ENTERPRISE';

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  name: string;
  adminEmail: string;
  tier: TenantTier;
}

export interface UpdateTenantInput {
  name?: string;
  adminEmail?: string;
  status?: TenantStatus;
  tier?: TenantTier;
}
