/**
 * JAM Challenge Submit API Proxy
 *
 * - POST: JAM 回答提出
 */

import { NextRequest } from 'next/server';
import {
  serverApiRequest,
  successResponse,
  badRequestResponse,
} from '@/lib/api/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string; challengeId: string }> },
) {
  const { eventId, challengeId } = await params;
  try {
    const body = await request.json();
    const data = await serverApiRequest(
      `/participant/events/${eventId}/challenges/${challengeId}/submit`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to submit answer',
    );
  }
}
