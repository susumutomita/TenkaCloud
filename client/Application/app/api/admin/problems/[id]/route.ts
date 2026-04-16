/**
 * Admin Problem Detail API
 *
 * 管理者向け個別問題管理エンドポイント
 * - GET: 問題詳細取得
 * - PUT: 問題更新
 * - DELETE: 問題削除
 */

import type { NextRequest } from 'next/server';
import type { AdminProblem } from '@/lib/api/admin-types';
import {
  badRequestResponse,
  forbiddenResponse,
  getAdminSession,
  serverApiRequest,
  successResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '@/lib/api/server';
import { authSkipEnabled } from '@/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function createFallbackProblem(id: string): AdminProblem {
  return {
    id,
    title: 'Untitled Problem',
    type: 'jam',
    category: 'security',
    difficulty: 'easy',
    description: {
      overview: '',
      objectives: [],
      hints: [],
      prerequisites: [],
      estimatedTime: 0,
    },
    metadata: {
      author: 'unknown',
      version: '1.0.0',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    deployment: {
      providers: ['aws'],
      timeout: 60,
      templates: {},
      regions: {},
    },
    scoring: {
      type: 'manual',
      path: '',
      timeoutMinutes: 60,
      criteria: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * GET /api/admin/problems/[id]
 *
 * 問題詳細を取得（管理者のみ）
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id } = await context.params;

  try {
    const data = await serverApiRequest<AdminProblem>(`/admin/problems/${id}`);
    return successResponse(data);
  } catch (error) {
    const isAuthSkipUnauthorized =
      authSkipEnabled &&
      error instanceof Error &&
      /^Unauthorized$/i.test(error.message);
    const isNetworkError =
      error instanceof TypeError && /fetch failed/i.test(String(error));

    if (isAuthSkipUnauthorized || isNetworkError) {
      console.error('Problem detail backend unreachable:', error);
      return serviceUnavailableResponse('Failed to fetch problem');
    }

    console.error('Failed to fetch problem:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch problem',
    );
  }
}

/**
 * PUT /api/admin/problems/[id]
 *
 * 問題を更新（管理者のみ）
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id } = await context.params;

  try {
    const body = await request.json();
    const data = await serverApiRequest<AdminProblem>(`/admin/problems/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return successResponse(data);
  } catch (error) {
    console.error('Failed to update problem:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update problem',
    );
  }
}

/**
 * DELETE /api/admin/problems/[id]
 *
 * 問題を削除（管理者のみ）
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id } = await context.params;

  try {
    const data = await serverApiRequest<{ success: boolean }>(
      `/admin/problems/${id}`,
      { method: 'DELETE' },
    );
    return successResponse(data);
  } catch (error) {
    console.error('Failed to delete problem:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete problem',
    );
  }
}
