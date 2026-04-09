/**
 * Admin Event Detail API
 *
 * 管理者向け個別イベント管理エンドポイント
 * - GET: イベント詳細取得
 * - PUT: イベント更新
 * - DELETE: イベント削除
 */

import { NextRequest } from 'next/server';
import { authSkipEnabled } from '@/auth';
import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { EventDetails, EventStatus } from '@/lib/api/types';
import { deleteDevEvent, findDevEvent, updateDevEvent } from '../dev-store';

/**
 * イベント更新リクエスト型
 */
interface UpdateEventRequest {
  name?: string;
  slug?: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  status?: EventStatus;
  imageUrl?: string;
}

function isLocalDevFallbackError(error: unknown): boolean {
  const isAuthSkipUnauthorized =
    authSkipEnabled &&
    error instanceof Error &&
    /^Unauthorized$/i.test(error.message);
  const isNetworkError =
    error instanceof TypeError && /fetch failed/i.test(String(error));
  return isAuthSkipUnauthorized || isNetworkError;
}

/**
 * GET /api/admin/events/[eventId]
 *
 * イベント詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const data = await serverApiRequest<EventDetails>(
      `/admin/events/${eventId}`,
    );
    return successResponse(data);
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin event detail fallback to local dev store:', error);
      const event = findDevEvent(eventId);
      if (event) {
        return successResponse(event);
      }
    }

    console.error('Failed to fetch event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch event',
    );
  }
}

/**
 * PUT /api/admin/events/[eventId]
 *
 * イベントを更新（管理者のみ）
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;
  const body = (await request.json()) as UpdateEventRequest;

  try {
    const data = await serverApiRequest<EventDetails>(
      `/admin/events/${eventId}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );

    return successResponse(data);
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin event update fallback to local dev store:', error);
      const event = updateDevEvent(eventId, body);
      if (event) {
        return successResponse(event);
      }
    }

    console.error('Failed to update event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update event',
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> },
) {
  return PUT(request, context);
}

/**
 * DELETE /api/admin/events/[eventId]
 *
 * イベントを削除（管理者のみ）
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    await serverApiRequest<void>(`/admin/events/${eventId}`, {
      method: 'DELETE',
    });

    return successResponse({ success: true, message: 'Event deleted' });
  } catch (error) {
    if (isLocalDevFallbackError(error) && deleteDevEvent(eventId)) {
      console.warn('Admin event delete fallback to local dev store:', error);
      return successResponse({ success: true, message: 'Event deleted' });
    }

    console.error('Failed to delete event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete event',
    );
  }
}
