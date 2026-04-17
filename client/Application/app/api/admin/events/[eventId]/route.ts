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
} from '@/lib/api/server';
import {
  fetchEvent,
  putEvent,
  removeEvent,
} from '@/lib/api/admin-event-service';
import type { UpdateEventRequest } from '@/lib/api/admin-event-service';

/**
 * GET /api/admin/events/[eventId]
 *
 * イベント詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const data = await fetchEvent(eventId);
    return successResponse(data);
  } catch (error) {
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
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;
  const body = (await request.json()) as UpdateEventRequest;

  try {
    const data = await putEvent(eventId, body);
    return successResponse(data);
  } catch (error) {
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
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const data = await removeEvent(eventId);
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete event',
    );
  }
}
