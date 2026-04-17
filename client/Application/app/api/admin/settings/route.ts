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
} from '@/lib/api/server';
import {
  fetchSettings,
  putSettings,
  regenerateApiKey,
  deleteAllData,
} from '@/lib/api/admin-settings-service';
import type {
  UpdateSettingsRequest,
  ActionRequest,
} from '@/lib/api/admin-settings-service';

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
    const data = await fetchSettings();
    return successResponse(data);
  } catch {
    return badRequestResponse('Failed to fetch settings');
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

  const body = (await request.json()) as UpdateSettingsRequest;

  if (body.tenantName !== undefined && !body.tenantName.trim()) {
    return badRequestResponse('Tenant name cannot be empty');
  }
  if (body.slug !== undefined && !body.slug.trim()) {
    return badRequestResponse('Slug cannot be empty');
  }

  try {
    const data = await putSettings(body);
    return successResponse(data);
  } catch {
    return badRequestResponse('Failed to update settings');
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

  const body = (await request.json()) as ActionRequest;

  if (!body.action) {
    return badRequestResponse('Action is required');
  }

  if (body.action === 'regenerate-api-key') {
    try {
      const data = await regenerateApiKey();
      return successResponse(data);
    } catch {
      return badRequestResponse('Failed to execute action');
    }
  }

  if (body.action === 'delete-all-data') {
    if (body.confirmationToken !== 'DELETE') {
      return badRequestResponse(
        'Confirmation token must be "DELETE" to proceed',
      );
    }

    try {
      const data = await deleteAllData(body.confirmationToken);
      return successResponse(data);
    } catch {
      return badRequestResponse('Failed to execute action');
    }
  }

  return badRequestResponse(`Unknown action: ${body.action}`);
}
