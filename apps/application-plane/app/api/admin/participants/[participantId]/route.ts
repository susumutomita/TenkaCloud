/**
 * Admin Participant Detail API
 *
 * 管理者向け個別参加者管理エンドポイント
 * - GET: 参加者詳細取得
 * - PUT: 参加者更新
 * - DELETE: 参加者削除
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
import type { ParticipantProfile } from '@/lib/api/types';

/**
 * 参加者更新リクエスト型
 */
interface UpdateParticipantRequest {
  name?: string;
  email?: string;
  teamId?: string | null;
  isActive?: boolean;
}

/**
 * GET /api/admin/participants/[participantId]
 *
 * 参加者詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { participantId } = await params;

  try {
    const data = await serverApiRequest<ParticipantProfile>(
      `/admin/participants/${participantId}`
    );
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch participant:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch participant'
    );
  }
}

/**
 * PUT /api/admin/participants/[participantId]
 *
 * 参加者を更新（管理者のみ）
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { participantId } = await params;

  try {
    const body = (await request.json()) as UpdateParticipantRequest;

    const data = await serverApiRequest<ParticipantProfile>(
      `/admin/participants/${participantId}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update participant:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update participant'
    );
  }
}

/**
 * DELETE /api/admin/participants/[participantId]
 *
 * 参加者を削除（管理者のみ）
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { participantId } = await params;

  try {
    await serverApiRequest<void>(`/admin/participants/${participantId}`, {
      method: 'DELETE',
    });

    return successResponse({ success: true, message: 'Participant deleted' });
  } catch (error) {
    console.error('Failed to delete participant:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete participant'
    );
  }
}
