/**
 * Admin Event Detail API
 *
 * 管理者向け個別イベント管理エンドポイント
 * - GET: イベント詳細取得
 * - PUT: イベント更新
 * - DELETE: イベント削除
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
import type { EventDetails, EventStatus } from '@/lib/api/types';

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

/**
 * GET /api/admin/events/[eventId]
 *
 * イベント詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
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
      `/admin/events/${eventId}`
    );
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch event'
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
  { params }: { params: Promise<{ eventId: string }> }
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
    const body = (await request.json()) as UpdateEventRequest;

    const data = await serverApiRequest<EventDetails>(
      `/admin/events/${eventId}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update event'
    );
  }
}

/**
 * DELETE /api/admin/events/[eventId]
 *
 * イベントを削除（管理者のみ）
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
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
    console.error('Failed to delete event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete event'
    );
  }
}
