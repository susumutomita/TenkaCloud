/**
 * Admin Challenge Detail API
 *
 * 管理者向け個別チャレンジ管理エンドポイント
 * - GET: チャレンジ詳細取得
 * - PUT: チャレンジ更新
 * - DELETE: チャレンジ削除
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
import type {
  ChallengeDetails,
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
} from '@/lib/api/types';

/**
 * チャレンジ更新リクエスト型
 */
interface UpdateChallengeRequest {
  title?: string;
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  overview?: string;
  description?: string;
  objectives?: string[];
  instructions?: string[];
  order?: number;
  unlockTime?: string;
  pointMultiplier?: number;
  maxScore?: number;
  estimatedTimeMinutes?: number;
}

/**
 * GET /api/admin/challenges/[challengeId]
 *
 * チャレンジ詳細を取得（管理者のみ）
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ challengeId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { challengeId } = await params;

  try {
    const data = await serverApiRequest<ChallengeDetails>(
      `/admin/challenges/${challengeId}`
    );
    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch challenge:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch challenge'
    );
  }
}

/**
 * PUT /api/admin/challenges/[challengeId]
 *
 * チャレンジを更新（管理者のみ）
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ challengeId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { challengeId } = await params;

  try {
    const body = (await request.json()) as UpdateChallengeRequest;

    const data = await serverApiRequest<ChallengeDetails>(
      `/admin/challenges/${challengeId}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update challenge:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update challenge'
    );
  }
}

/**
 * DELETE /api/admin/challenges/[challengeId]
 *
 * チャレンジを削除（管理者のみ）
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ challengeId: string }> }
) {
  // 管理者権限チェック
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { challengeId } = await params;

  try {
    await serverApiRequest<void>(`/admin/challenges/${challengeId}`, {
      method: 'DELETE',
    });

    return successResponse({ success: true, message: 'Challenge deleted' });
  } catch (error) {
    console.error('Failed to delete challenge:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete challenge'
    );
  }
}
