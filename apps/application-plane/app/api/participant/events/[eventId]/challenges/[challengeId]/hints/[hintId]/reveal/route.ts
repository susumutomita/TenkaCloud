/**
 * Challenge Hint Reveal API Proxy
 *
 * - POST: ヒント公開
 */

import {
  serverApiRequest,
  successResponse,
  badRequestResponse,
} from '@/lib/api/server';

export async function POST(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ eventId: string; challengeId: string; hintId: string }>;
  },
) {
  const { eventId, challengeId, hintId } = await params;
  try {
    const data = await serverApiRequest(
      `/participant/events/${eventId}/challenges/${challengeId}/hints/${hintId}/reveal`,
      { method: 'POST' },
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to reveal hint',
    );
  }
}
