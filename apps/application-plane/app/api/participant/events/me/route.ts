/**
 * Participant My Events API Proxy
 *
 * 参加中のイベント一覧エンドポイント
 */

import { authSkipEnabled } from '@/auth';
import {
  successResponse,
  badRequestResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { ParticipantEvent } from '@/lib/api/types';

interface MyEventsResponse {
  events: ParticipantEvent[];
}

/**
 * GET /api/participant/events/me
 *
 * 参加中のイベント一覧を取得
 */
export async function GET() {
  try {
    const data = await serverApiRequest<MyEventsResponse>(
      '/participant/events/me',
    );
    return successResponse(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);

    if (error instanceof TypeError) {
      console.warn('Participant my-events backend unreachable:', error);
      return successResponse({ events: [] });
    }

    if (isAuthSkipUnauthorized) {
      console.warn(
        'Participant my-events backend rejected AUTH_SKIP token. Returning empty list.',
        error,
      );
      return successResponse({ events: [] });
    }

    console.error('Failed to fetch my events:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch events',
    );
  }
}
