/**
 * Participant Event Detail API Proxy
 *
 * 参加者向けイベント詳細エンドポイント
 */

import { serverApiRequest } from '@/lib/api/server';
import type { EventDetails } from '@/lib/api/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;

  try {
    const data = await serverApiRequest<EventDetails>(
      `/participant/events/${eventId}`
    );
    return Response.json(data);
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes('404') ? 404 : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch event',
      },
      { status }
    );
  }
}
