/**
 * Admin Challenges API
 *
 * 管理者向けチャレンジ（問題）管理エンドポイント
 * - GET: チャレンジ一覧取得
 * - POST: チャレンジ作成
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
  ChallengeProblem,
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
} from '@/lib/api/types';

/**
 * Admin チャレンジ一覧レスポンス型
 */
interface AdminChallengeListResponse {
  challenges: ChallengeProblem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * チャレンジ作成リクエスト型
 */
interface CreateChallengeRequest {
  eventId: string;
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  overview: string;
  description: string;
  objectives: string[];
  instructions: string[];
  order?: number;
  unlockTime?: string;
  pointMultiplier?: number;
  maxScore: number;
  estimatedTimeMinutes?: number;
}

/**
 * GET /api/admin/challenges
 *
 * チャレンジ一覧を取得（管理者のみ）
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
  const type = searchParams.get('type') as ProblemType | null;
  const category = searchParams.get('category') as ProblemCategory | null;
  const difficulty = searchParams.get('difficulty') as DifficultyLevel | null;
  const search = searchParams.get('search');

  try {
    // バックエンド API を呼び出し
    const queryParams = new URLSearchParams();
    queryParams.set('page', String(page));
    queryParams.set('pageSize', String(pageSize));
    if (eventId) queryParams.set('eventId', eventId);
    if (type) queryParams.set('type', type);
    if (category) queryParams.set('category', category);
    if (difficulty) queryParams.set('difficulty', difficulty);
    if (search) queryParams.set('search', search);

    const data = await serverApiRequest<AdminChallengeListResponse>(
      `/admin/challenges?${queryParams.toString()}`
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to fetch challenges:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch challenges'
    );
  }
}

/**
 * POST /api/admin/challenges
 *
 * 新規チャレンジを作成（管理者のみ）
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
    const body = (await request.json()) as CreateChallengeRequest;

    // 必須フィールドのバリデーション
    if (!body.eventId?.trim()) {
      return badRequestResponse('Event ID is required');
    }
    if (!body.title?.trim()) {
      return badRequestResponse('Challenge title is required');
    }
    if (!body.type) {
      return badRequestResponse('Challenge type is required');
    }
    if (!body.category) {
      return badRequestResponse('Challenge category is required');
    }
    if (!body.difficulty) {
      return badRequestResponse('Difficulty level is required');
    }
    if (body.maxScore === undefined || body.maxScore <= 0) {
      return badRequestResponse('Max score must be a positive number');
    }

    // バックエンド API を呼び出し
    const data = await serverApiRequest<ChallengeProblem>('/admin/challenges', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to create challenge:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create challenge'
    );
  }
}
