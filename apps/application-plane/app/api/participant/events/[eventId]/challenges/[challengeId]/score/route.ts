/**
 * Challenge Score API Proxy
 *
 * - POST: GameDay 採点リクエスト
 */

import {
  serverApiRequest,
  successResponse,
  badRequestResponse,
} from '@/lib/api/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ eventId: string; challengeId: string }> },
) {
  const { eventId, challengeId } = await params;
  try {
    const data = await serverApiRequest(
      `/participant/events/${eventId}/challenges/${challengeId}/score`,
      { method: 'POST' },
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to request scoring',
    );
  }
}
