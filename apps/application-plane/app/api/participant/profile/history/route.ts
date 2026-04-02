/**
 * Profile History API Proxy
 */

import { NextRequest } from 'next/server';
import { serverApiRequest, successResponse } from '@/lib/api/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const params = new URLSearchParams();
  const limit = searchParams.get('limit');
  const offset = searchParams.get('offset');
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  const qs = params.toString();
  const data = await serverApiRequest(
    `/participant/profile/history${qs ? `?${qs}` : ''}`
  );
  return successResponse(data);
}
