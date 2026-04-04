/**
 * Admin Event Publish API
 *
 * 管理者向けイベントステータス遷移エンドポイント
 * - POST: イベントのステータスを変更（例: draft -> published -> running -> finished）
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
import type { EventDetails } from '@/lib/api/types';

/**
 * 有効なステータス遷移先
 */
const VALID_TRANSITION_STATUSES = ['published', 'running', 'finished'] as const;

type TransitionStatus = (typeof VALID_TRANSITION_STATUSES)[number];

/**
 * ステータス遷移リクエスト型
 */
interface PublishEventRequest {
  status?: string;
}

/**
 * POST /api/admin/events/[eventId]/publish
 *
 * イベントのステータスを遷移（管理者のみ）
 */
export async function POST(
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

  try {
    const body = (await request.json()) as PublishEventRequest;

    if (!body.status) {
      return badRequestResponse('Status is required');
    }

    if (!VALID_TRANSITION_STATUSES.includes(body.status as TransitionStatus)) {
      return badRequestResponse(
        `Invalid status: ${body.status}. Must be one of: ${VALID_TRANSITION_STATUSES.join(', ')}`,
      );
    }

    const data = await serverApiRequest<EventDetails>(
      `/admin/events/${eventId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: body.status }),
      },
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update event status:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update event status',
    );
  }
}
