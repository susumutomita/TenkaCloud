/**
 * Admin Event Problems API
 *
 * イベントの問題管理エンドポイント
 * - GET: イベントの問題一覧取得
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
 * GET /api/admin/events/[eventId]/problems
 *
 * イベントの問題一覧を取得（管理者のみ）
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
    const data = await serverApiRequest(`/admin/events/${eventId}/problems`);
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch event problems:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch event problems',
    );
  }
}

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
    const body = (await request.json()) as AddProblemToEventRequest;

    if (!body.problemId?.trim()) {
      return badRequestResponse('Problem ID is required');
    }

    const data = await serverApiRequest<AddProblemToEventResponse>(
      `/admin/events/${eventId}/problems`,
      {
        method: 'POST',
        body: JSON.stringify({ problemId: body.problemId }),
      },
    );

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to add problem to event:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to add problem to event',
    );
  }
}
