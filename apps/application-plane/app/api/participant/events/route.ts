/**
 * Participant Events API Proxy
 *
 * 参加者向けイベント一覧エンドポイント
 * クライアントからの直接 problem-service 接続を避け、
 * サーバーサイドでプロキシする
 */

import { NextRequest } from 'next/server';
import { authSkipEnabled } from '@/auth';
import {
  successResponse,
  badRequestResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { ParticipantEvent } from '@/lib/api/types';

interface ParticipantEventListResponse {
  events: ParticipantEvent[];
  total: number;
}

/**
 * GET /api/participant/events
 *
 * イベント一覧を取得（参加者向け）
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const queryParams = new URLSearchParams();
  const status = searchParams.get('status');
  const type = searchParams.get('type');
  const limit = searchParams.get('limit');
  const offset = searchParams.get('offset');

  if (status) queryParams.set('status', status);
  if (type) queryParams.set('type', type);
  if (limit) queryParams.set('limit', limit);
  if (offset) queryParams.set('offset', offset);

  const queryString = queryParams.toString();
  const endpoint = `/participant/events${queryString ? `?${queryString}` : ''}`;

  try {
    const data = await serverApiRequest<ParticipantEventListResponse>(endpoint);
    return successResponse(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized) {
      console.warn(
        'Participant events backend rejected AUTH_SKIP token. Returning empty list.',
        error,
      );
      return successResponse({ events: [], total: 0 });
    }

    if (isNetworkError) {
      return successResponse({ events: [], total: 0 });
    }

    console.error('Failed to fetch participant events:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch events',
    );
  }
}
