import type { ActivitiesResponse } from '@/types/activity';

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:13004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:13004/api';

/**
 * Fetch recent activities from the API
 */
export async function fetchActivities(limit = 10): Promise<ActivitiesResponse> {
  const res = await fetch(`${apiBaseUrl}/activities?limit=${limit}`, {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch activities: ${res.status}`);
  }

  return res.json() as Promise<ActivitiesResponse>;
}
