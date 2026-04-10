/**
 * Participant Event Detail API Proxy
 *
 * 参加者向けイベント詳細エンドポイント
 */

import { authSkipEnabled } from '@/auth';
import { getDevEventDetails } from '@/app/api/admin/events/dev-store';
import { serverApiRequest } from '@/lib/api/server';
import type { EventDetails } from '@/lib/api/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<EventDetails>(
      `/participant/events/${eventId}`,
    );
    return Response.json(data);
  } catch (error) {
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const isAuthSkipUnauthorized =
      isDevelopment &&
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      isDevelopment &&
      error instanceof TypeError &&
      /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized || isNetworkError) {
      const data = getDevEventDetails(eventId);
      if (data) {
        return Response.json(data);
      }
    }

    const status =
      error instanceof Error && error.message.includes('404') ? 404 : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch event',
      },
      { status },
    );
  }
}
