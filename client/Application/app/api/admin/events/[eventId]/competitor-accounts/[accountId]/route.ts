/**
 * Admin Competitor Account (single) API
 *
 * - DELETE: 競技アカウント削除
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
  params: Promise<{ eventId: string; accountId: string }>;
};

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId, accountId } = await params;

  try {
    await serverApiRequest(
      `/admin/events/${eventId}/competitor-accounts/${accountId}`,
      { method: 'DELETE' },
    );
    return successResponse({ success: true });
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete account',
    );
  }
}
