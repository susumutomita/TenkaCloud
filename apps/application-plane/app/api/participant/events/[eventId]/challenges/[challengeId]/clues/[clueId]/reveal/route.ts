/**
 * JAM Clue Reveal API Proxy
 *
 * - POST: JAM クルー公開
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
    params: Promise<{ eventId: string; challengeId: string; clueId: string }>;
  },
) {
  const { eventId, challengeId, clueId } = await params;
  try {
    const data = await serverApiRequest(
      `/participant/events/${eventId}/challenges/${challengeId}/clues/${clueId}/reveal`,
      { method: 'POST' },
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to reveal clue',
    );
  }
}
