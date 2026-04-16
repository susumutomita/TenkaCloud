/**
 * Admin Event Participants API
 *
 * 管理者向けイベント参加者管理エンドポイント
 * - GET: 参加者一覧取得
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
 * GET /api/admin/events/[eventId]/participants
 *
 * イベントの参加者一覧を取得（管理者のみ）
 */
export async function GET(
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
    const { searchParams } = request.nextUrl;
    const queryString = searchParams.toString();
    const path = `/admin/events/${eventId}/participants${queryString ? `?${queryString}` : ''}`;

    const data = await serverApiRequest(path);
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch participants:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch participants',
    );
  }
}
