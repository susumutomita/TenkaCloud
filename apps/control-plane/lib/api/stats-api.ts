// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:3004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:3004/api';

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
  const res = await fetch(`${apiBaseUrl}/stats`, { cache: 'no-store' });

  if (!res.ok) {
    throw new Error(`Failed to fetch stats: ${res.status}`);
  }

  return res.json() as Promise<DashboardStats>;
}
