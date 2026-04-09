/**
 * Admin GameDay Deployments API
 *
 * - GET: デプロイジョブ一覧取得
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

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId, problemId } = await params;

  try {
    const data = await serverApiRequest(
      `/admin/events/${eventId}/problems/${problemId}/deployments`,
    );
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to list deployments',
    );
  }
}
