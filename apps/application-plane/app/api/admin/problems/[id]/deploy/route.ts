/**
 * Admin Problem Deploy API
 *
 * CloudFormation スタックの作成・ステータス取得・削除
 *
 * - POST: スタック作成
 * - GET: ステータス・イベント・Outputs 取得
 * - DELETE: スタック削除
 */

import type { NextRequest } from 'next/server';
import type {
  DeploymentStatus,
  DeployProblemResponse,
} from '@/lib/api/admin-types';
import {
  badRequestResponse,
  forbiddenResponse,
  getAdminSession,
  serverApiRequest,
  successResponse,
  unauthorizedResponse,
} from '@/lib/api/server';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/problems/[id]/deploy
 *
 * CloudFormation スタックを作成
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id: problemId } = await context.params;

  try {
    const body = (await request.json()) as {
      region?: string;
      parameters?: Record<string, string>;
    };

    if (!body.region?.trim()) {
      return badRequestResponse('Region is required');
    }

    const data = await serverApiRequest<DeployProblemResponse>(
      `/admin/problems/${problemId}/deploy`,
      {
        method: 'POST',
        body: JSON.stringify({
          region: body.region,
          parameters: body.parameters,
        }),
      },
    );

    return successResponse(data, 201);
  } catch (error) {
    console.error('Failed to deploy problem:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to deploy',
    );
  }
}

/**
 * GET /api/admin/problems/[id]/deploy
 *
 * スタックステータス・イベント・Outputs を取得
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id: problemId } = await context.params;

  try {
    const data = await serverApiRequest<DeploymentStatus>(
      `/admin/problems/${problemId}/deploy`,
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to get deploy status:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to get status',
    );
  }
}

/**
 * DELETE /api/admin/problems/[id]/deploy
 *
 * スタックを削除
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  const { id: problemId } = await context.params;

  try {
    const data = await serverApiRequest<{ message: string }>(
      `/admin/problems/${problemId}/deploy`,
      { method: 'DELETE' },
    );

    return successResponse(data);
  } catch (error) {
    console.error('Failed to delete stack:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to delete stack',
    );
  }
}
