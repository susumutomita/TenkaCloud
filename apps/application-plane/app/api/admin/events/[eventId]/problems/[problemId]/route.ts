/**
 * Admin Event Problem Delete API
 *
 * - DELETE: イベントから問題を削除
 */

import { NextRequest } from 'next/server';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string; problemId: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId, problemId } = await params;

  try {
    await serverApiRequest(`/admin/events/${eventId}/problems/${problemId}`, {
      method: 'DELETE',
    });
    return successResponse({ success: true });
  } catch (error) {
    console.error('Failed to remove problem from event:', error);
    return badRequestResponse(
      error instanceof Error
        ? error.message
        : 'Failed to remove problem from event',
    );
  }
}
