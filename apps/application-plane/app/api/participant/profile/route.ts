/**
 * Profile API Proxy
 */

import { serverApiRequest, successResponse } from '@/lib/api/server';

export async function GET() {
  const data = await serverApiRequest('/participant/profile');
  return successResponse(data);
}
