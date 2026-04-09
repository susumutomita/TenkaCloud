/**
 * Admin Problems API
 *
 * 管理者向け問題管理エンドポイント
 * - GET: 問題一覧取得
 * - POST: 問題作成
 */

import type { NextRequest } from 'next/server';
import type {
  AdminProblem,
  AdminProblemListResponse,
} from '@/lib/api/admin-types';
import {
  badRequestResponse,
  forbiddenResponse,
  getAdminSession,
  serverApiRequest,
  successResponse,
  unauthorizedResponse,
} from '@/lib/api/server';
import { authSkipEnabled } from '@/auth';

function buildProblemListQuery(params: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of [
    'type',
    'category',
    'difficulty',
    'search',
    'limit',
    'offset',
  ] as const) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return query.toString();
}

function emptyProblemList(): AdminProblemListResponse {
  return {
    problems: [],
    total: 0,
  };
}

/**
 * GET /api/admin/problems
 *
 * 問題一覧を取得（管理者のみ）
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { searchParams } = new URL(request.url);
  const query = buildProblemListQuery(searchParams);

  try {
    const data = await serverApiRequest<AdminProblemListResponse>(
      query ? `/admin/problems?${query}` : '/admin/problems',
    );
    return successResponse(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized || isNetworkError) {
      console.warn('Problems list fallback to empty dataset:', error);
      return successResponse(emptyProblemList());
    }

    console.error('Failed to fetch problems:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch problems',
    );
  }
}

/**
 * POST /api/admin/problems
 *
 * 問題を作成（管理者のみ）
 */
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  try {
    const body = await request.json();
    const data = await serverApiRequest<AdminProblem>('/admin/problems', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to create problem:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to create problem',
    );
  }
}
