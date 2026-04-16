/**
 * Challenge Submissions API Proxy
 *
 * - GET: 提出履歴取得
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
      `/participant/events/${eventId}/challenges/${challengeId}/submissions`,
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch submissions',
    );
  }
}
