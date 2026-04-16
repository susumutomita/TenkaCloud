/**
 * Admin Settings API
 *
 * 管理者向け設定エンドポイント
 * - GET: 現在の設定を取得
 * - PUT: 設定を更新（name, slug）
 * - POST: アクション実行（API キー再生成、全データ削除）
 */

import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { authSkipEnabled } from '@/auth';
import {
  getAdminSession,
  unauthorizedResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';
import { clearDevEvents } from '../events/dev-store';

/**
 * 設定レスポンス型
 */
interface SettingsResponse {
  tenantName: string;
  slug: string;
  apiKey: string;
}

function buildDevApiKey() {
  return `sk-dev-${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function getDevSettingsStore(): SettingsResponse {
  const globalStore = globalThis as typeof globalThis & {
    __TENKACLOUD_DEV_SETTINGS__?: SettingsResponse;
  };
  if (!globalStore.__TENKACLOUD_DEV_SETTINGS__) {
    globalStore.__TENKACLOUD_DEV_SETTINGS__ = {
      tenantName: 'Dev Tenant',
      slug: 'dev-tenant',
      apiKey: buildDevApiKey(),
    };
  }
  return globalStore.__TENKACLOUD_DEV_SETTINGS__;
}

function setDevSettingsStore(next: SettingsResponse) {
  const globalStore = globalThis as typeof globalThis & {
    __TENKACLOUD_DEV_SETTINGS__?: SettingsResponse;
  };
  globalStore.__TENKACLOUD_DEV_SETTINGS__ = next;
  return next;
}

function isLocalDevFallbackError(error: unknown): boolean {
  const isAuthSkipUnauthorized =
    authSkipEnabled &&
    error instanceof Error &&
    /^Unauthorized$/i.test(error.message);
  const isNetworkError =
    error instanceof TypeError && /fetch failed/i.test(String(error));
  return isAuthSkipUnauthorized || isNetworkError;
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
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings fallback to local dev store:', error);
      return successResponse(getDevSettingsStore());
    }

    console.error('Failed to fetch settings:', error);
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

  try {
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
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings update fallback to local dev store:', error);
      const current = getDevSettingsStore();
      return successResponse(
        setDevSettingsStore({
          ...current,
          tenantName: body.tenantName ?? current.tenantName,
          slug: body.slug ?? current.slug,
        }),
      );
    }

    console.error('Failed to update settings:', error);
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

  try {
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
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings action fallback to local dev store:', error);
      if (body.action === 'regenerate-api-key') {
        const current = getDevSettingsStore();
        return successResponse(
          setDevSettingsStore({
            ...current,
            apiKey: buildDevApiKey(),
          }),
        );
      }
      if (body.action === 'delete-all-data') {
        clearDevEvents();
        return successResponse({ success: true });
      }
    }

    console.error('Failed to execute action:', error);
    return badRequestResponse('Failed to execute action');
  }
}
