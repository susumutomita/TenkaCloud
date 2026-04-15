/**
 * Rankings API Proxy
 *
 * グローバルランキングエンドポイント
 */

import { NextRequest } from 'next/server';
import {
  badRequestResponse,
  isAuthSkipUnauthorizedError,
  serverApiRequest,
  serviceUnavailableResponse,
  successResponse,
} from '@/lib/api/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const params = new URLSearchParams();
  const limit = searchParams.get('limit');
  const offset = searchParams.get('offset');
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);

  const qs = params.toString();
  try {
    const data = await serverApiRequest(
      `/participant/rankings${qs ? `?${qs}` : ''}`,
    );
    return successResponse(data);
  } catch (err) {
    if (isAuthSkipUnauthorizedError(err)) {
      console.error(
        'Participant rankings backend rejected AUTH_SKIP token:',
        err,
      );
      return serviceUnavailableResponse('Failed to fetch rankings');
    }

    const isNetworkError =
      err instanceof TypeError && /fetch failed/i.test(String(err));

    if (isNetworkError) {
      console.error('Participant rankings backend unreachable:', err);
      return serviceUnavailableResponse('Failed to fetch rankings');
    }

    console.error('Failed to fetch participant rankings:', err);
    return badRequestResponse(
      err instanceof Error ? err.message : 'Failed to fetch rankings',
    );
  }
}
