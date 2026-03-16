/**
 * Participant My Events API Proxy
 *
 * 参加中のイベント一覧エンドポイント
 */

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
      '/participant/events/me'
    );
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch my events:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch events'
    );
  }
}
