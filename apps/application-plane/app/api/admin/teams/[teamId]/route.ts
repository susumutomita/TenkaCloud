/**
 * Admin Team Detail API
 *
 * 管理者向け個別チーム管理エンドポイント
 * - GET: チーム詳細取得
 * - PUT: チーム更新
 * - DELETE: チーム削除
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
import type { TeamInfo } from '@/lib/api/types';

/**
 * チーム更新リクエスト型
 */
interface UpdateTeamRequest {
  name?: string;
  captainId?: string;
  memberIds?: string[];
}

/**
 * GET /api/admin/teams/[teamId]
 *
 * チーム詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { teamId } = await params;

  try {
    const data = await serverApiRequest<TeamInfo>(`/admin/teams/${teamId}`);
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch team:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch team'
    );
  }
}

/**
 * PUT /api/admin/teams/[teamId]
 *
 * チームを更新（管理者のみ）
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { teamId } = await params;

  try {
    const body = (await request.json()) as UpdateTeamRequest;

    const data = await serverApiRequest<TeamInfo>(`/admin/teams/${teamId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update team:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update team'
    );
  }
}

/**
 * DELETE /api/admin/teams/[teamId]
 *
 * チームを削除（管理者のみ）
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { teamId } = await params;

  try {
    await serverApiRequest<void>(`/admin/teams/${teamId}`, {
      method: 'DELETE',
    });

    return successResponse({ success: true, message: 'Team deleted' });
  } catch (error) {
    console.error('Failed to delete team:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete team'
    );
  }
}
