/**
 * Admin Settings API
 *
 * 管理者向け設定エンドポイント
 * - GET: 現在の設定を取得
 * - PUT: 設定を更新（name, slug）
 * - POST: アクション実行（API キー再生成、全データ削除）
 */

import { NextRequest } from 'next/server';
import {
  getAdminSession,
  unauthorizedResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';

/**
 * 設定レスポンス型
 */
interface SettingsResponse {
  tenantName: string;
  slug: string;
  apiKey: string;
}

/**
 * 設定更新リクエスト型
 */
interface UpdateSettingsRequest {
  tenantName?: string;
  slug?: string;
}

/**
 * アクションリクエスト型
 */
interface ActionRequest {
  action: 'regenerate-api-key' | 'delete-all-data';
  confirmationToken?: string;
}

/**
 * GET /api/admin/settings
 *
 * 現在の設定を取得（管理者のみ）
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return unauthorizedResponse('Authentication required');
  }

  try {
    const data = await serverApiRequest<SettingsResponse>('/admin/settings');
    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch settings',
    );
  }
}

/**
 * PUT /api/admin/settings
 *
 * 設定を更新（管理者のみ）
 */
export async function PUT(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return unauthorizedResponse('Authentication required');
  }

  try {
    const body = (await request.json()) as UpdateSettingsRequest;

    if (body.tenantName !== undefined && !body.tenantName.trim()) {
      return badRequestResponse('Tenant name cannot be empty');
    }
    if (body.slug !== undefined && !body.slug.trim()) {
      return badRequestResponse('Slug cannot be empty');
    }

    const data = await serverApiRequest<SettingsResponse>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    return successResponse(data);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to update settings',
    );
  }
}

/**
 * POST /api/admin/settings
 *
 * アクション実行（管理者のみ）
 * - regenerate-api-key: API キーを再生成
 * - delete-all-data: 全データ削除（確認トークン必須）
 */
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return unauthorizedResponse('Authentication required');
  }

  try {
    const body = (await request.json()) as ActionRequest;

    if (!body.action) {
      return badRequestResponse('Action is required');
    }

    if (body.action === 'regenerate-api-key') {
      const data = await serverApiRequest<SettingsResponse>(
        '/admin/settings/api-key',
        {
          method: 'POST',
        },
      );
      return successResponse(data);
    }

    if (body.action === 'delete-all-data') {
      if (body.confirmationToken !== 'DELETE') {
        return badRequestResponse(
          'Confirmation token must be "DELETE" to proceed',
        );
      }

      const data = await serverApiRequest<{ success: boolean }>(
        '/admin/settings/delete-all-data',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmationToken: body.confirmationToken,
          }),
        },
      );
      return successResponse(data);
    }

    return badRequestResponse(`Unknown action: ${body.action}`);
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to execute action',
    );
  }
}
