import { adminFetch } from './admin-api-client';

export interface ProvisioningStats {
  completed: number;
  inProgress: number;
  failed: number;
  pending: number;
}

export interface DashboardStats {
  activeTenants: number;
  totalTenants: number;
  systemStatus: 'healthy' | 'degraded' | 'down';
  uptimePercentage: number;
  provisioningStats?: ProvisioningStats;
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await adminFetch('tenant-management', '/api/stats', {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch stats: ${res.status}`);
  }

  return res.json() as Promise<DashboardStats>;
}
