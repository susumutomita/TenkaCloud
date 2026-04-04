/**
 * Admin Teams API
 *
 * 管理者向けチーム管理エンドポイント
 * - GET: チーム一覧取得
 * - POST: チーム作成
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
 * Admin チーム一覧レスポンス型
 */
interface AdminTeamListResponse {
  teams: TeamInfo[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * チーム作成リクエスト型
 */
interface CreateTeamRequest {
  name: string;
  eventId: string;
  captainId?: string;
  memberIds?: string[];
}

/**
 * GET /api/admin/teams
 *
 * チーム一覧を取得（管理者のみ）
 */
export async function GET(request: NextRequest) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  // クエリパラメータ取得
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);
  const eventId = searchParams.get('eventId');
  const search = searchParams.get('search');

  try {
    // バックエンド API を呼び出し
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('pageSize', String(pageSize));
    if (eventId) queryParams.set('eventId', eventId);
    if (search) queryParams.set('search', search);

    const data = await serverApiRequest<AdminTeamListResponse>(
      `/admin/teams?${queryParams.toString()}`
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch teams:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch teams'
    );
  }
}

/**
 * POST /api/admin/teams
 *
 * 新規チームを作成（管理者のみ）
 */
export async function POST(request: NextRequest) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  try {
    const body = (await request.json()) as CreateTeamRequest;

    // 必須フィールドのバリデーション
    if (!body.name?.trim()) {
      return badRequestResponse('Team name is required');
    }
    if (!body.eventId?.trim()) {
      return badRequestResponse('Event ID is required');
    }

    // バックエンド API を呼び出し
    const data = await serverApiRequest<TeamInfo>('/admin/teams', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to create team:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create team'
    );
  }
}
