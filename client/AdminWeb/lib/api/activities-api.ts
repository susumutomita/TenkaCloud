import type { ActivitiesResponse } from '@/types/activity';
import { adminFetch } from './admin-api-client';

export async function fetchActivities(limit = 10): Promise<ActivitiesResponse> {
  const res = await adminFetch(
    'tenant-management',
    `/api/activities?limit=${limit}`,
    { cache: 'no-store' },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch activities: ${res.status}`);
  }

  return res.json() as Promise<ActivitiesResponse>;
}
