/**
 * Admin Event Problems API
 *
 * イベントへの問題追加エンドポイント
 * - POST: イベントに問題を追加
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

/**
 * イベント問題追加リクエスト型
 */
interface AddProblemToEventRequest {
  problemId: string;
}

/**
 * イベント問題追加レスポンス型
 */
interface AddProblemToEventResponse {
  eventId: string;
  problemId: string;
  addedAt: string;
}

/**
 * POST /api/admin/events/[eventId]/problems
 *
 * イベントに問題を追加（管理者のみ）
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { eventId } = await params;

  try {
    const body = (await request.json()) as AddProblemToEventRequest;

    if (!body.problemId?.trim()) {
      return badRequestResponse('Problem ID is required');
    }

    const data = await serverApiRequest<AddProblemToEventResponse>(
      `/admin/events/${eventId}/problems`,
      {
        method: 'POST',
        body: JSON.stringify({ problemId: body.problemId }),
      }
    );

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to add problem to event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to add problem to event'
    );
  }
}
