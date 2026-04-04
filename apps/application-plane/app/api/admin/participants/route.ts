/**
 * Admin Participants API
 *
 * 管理者向け参加者管理エンドポイント
 * - GET: 参加者一覧取得
 * - POST: 参加者追加/招待
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
 * Admin 参加者一覧レスポンス型
 */
interface AdminParticipantListResponse {
  participants: ParticipantProfile[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 参加者追加リクエスト型
 */
interface AddParticipantRequest {
  email: string;
  name?: string;
  eventId?: string;
  teamId?: string;
}

/**
 * GET /api/admin/participants
 *
 * 参加者一覧を取得（管理者のみ）
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
  const teamId = searchParams.get('teamId');
  const search = searchParams.get('search');

  try {
    // バックエンド API を呼び出し
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('pageSize', String(pageSize));
    if (eventId) queryParams.set('eventId', eventId);
    if (teamId) queryParams.set('teamId', teamId);
    if (search) queryParams.set('search', search);

    const data = await serverApiRequest<AdminParticipantListResponse>(
      `/admin/participants?${queryParams.toString()}`
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch participants:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch participants'
    );
  }
}

/**
 * POST /api/admin/participants
 *
 * 参加者を追加/招待（管理者のみ）
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
    const body = (await request.json()) as AddParticipantRequest;

    // 必須フィールドのバリデーション
    if (!body.email?.trim()) {
      return badRequestResponse('Email is required');
    }

    // バックエンド API を呼び出し
    const data = await serverApiRequest<ParticipantProfile>(
      '/admin/participants',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to add participant:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to add participant'
    );
  }
}
