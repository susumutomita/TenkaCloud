/**
 * Rankings API Proxy
 *
 * グローバルランキングエンドポイント
 */

import { NextRequest } from 'next/server';
import { authSkipEnabled } from '@/auth';
import {
  badRequestResponse,
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
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      err instanceof Error &&
      /^Unauthorized$/i.test(err.message);

    // 起動タイミングの競合によるネットワーク到達不能のみ空リストで返す
    // それ以外のエラー（認証エラー、サービス障害等）は伝播させる
    const isNetworkError =
      err instanceof TypeError && /fetch failed/i.test(String(err));

    if (isAuthSkipUnauthorized) {
      console.error(
        'Participant rankings backend rejected AUTH_SKIP token:',
        err,
      );
      return serviceUnavailableResponse('Failed to fetch rankings');
    }

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
