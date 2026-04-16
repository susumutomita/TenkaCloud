/**
 * Challenge Detail API Proxy
 *
 * - GET: チャレンジ詳細取得
 */

import {
  serverApiRequest,
  successResponse,
  badRequestResponse,
} from '@/lib/api/server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ eventId: string; challengeId: string }> },
) {
  const { eventId, challengeId } = await params;
  try {
    const data = await serverApiRequest(
      `/participant/events/${eventId}/challenges/${challengeId}`,
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch challenge',
    );
  }
}
