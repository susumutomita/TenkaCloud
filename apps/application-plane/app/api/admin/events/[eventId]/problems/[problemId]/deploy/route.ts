/**
 * Admin GameDay Problem Deploy API
 *
 * - POST: 問題を全競技チームへデプロイ
 */

import type { NextRequest } from 'next/server';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';

type RouteContext = {
  params: Promise<{ eventId: string; problemId: string }>;
};

export async function POST(_request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId, problemId } = await params;

  try {
    const data = await serverApiRequest(
      `/admin/events/${eventId}/problems/${problemId}/deploy`,
      { method: 'POST', body: '{}' },
    );
    return successResponse(data, 202);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to start deployment',
    );
  }
}
