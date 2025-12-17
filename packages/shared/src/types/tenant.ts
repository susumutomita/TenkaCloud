/**
 * テナントの状態
 */
export type TenantStatus = 'active' | 'suspended' | 'deleted';

/**
 * テナントのティア
 */
export type TenantTier = 'free' | 'pro' | 'enterprise';

/**
 * テナント情報
 */
export interface Tenant {
  id: string;
  name: string;
  adminEmail: string;
  status: TenantStatus;
  tier: TenantTier;
  createdAt: string;
  updatedAt: string;
}
