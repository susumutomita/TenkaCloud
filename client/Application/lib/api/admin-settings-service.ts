/**
 * Admin Settings Service
 *
 * 管理者向け設定操作のサービス層
 * バックエンド API 呼び出しとローカル dev store フォールバックを担当
 */

import { randomBytes } from 'node:crypto';
import { authSkipEnabled } from '@/auth';
import { serverApiRequest } from '@/lib/api/server';
import { clearDevEvents } from '@/app/api/admin/events/dev-store';

/**
 * 設定レスポンス型
 */
export interface SettingsResponse {
  tenantName: string;
  slug: string;
  apiKey: string;
}

/**
 * 設定更新リクエスト型
 */
export interface UpdateSettingsRequest {
  tenantName?: string;
  slug?: string;
}

/**
 * アクションリクエスト型
 */
export interface ActionRequest {
  action: 'regenerate-api-key' | 'delete-all-data';
  confirmationToken?: string;
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
 * 設定を取得
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function fetchSettings(): Promise<SettingsResponse> {
  try {
    return await serverApiRequest<SettingsResponse>('/admin/settings');
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings fallback to local dev store:', error);
      return getDevSettingsStore();
    }

    console.error('Failed to fetch settings:', error);
    throw new Error('Failed to fetch settings');
  }
}

/**
 * 設定を更新
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function putSettings(
  body: UpdateSettingsRequest,
): Promise<SettingsResponse> {
  try {
    return await serverApiRequest<SettingsResponse>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings update fallback to local dev store:', error);
      const current = getDevSettingsStore();
      return setDevSettingsStore({
        ...current,
        tenantName: body.tenantName ?? current.tenantName,
        slug: body.slug ?? current.slug,
      });
    }

    console.error('Failed to update settings:', error);
    throw new Error('Failed to update settings');
  }
}

/**
 * API キーを再生成
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function regenerateApiKey(): Promise<SettingsResponse> {
  try {
    return await serverApiRequest<SettingsResponse>('/admin/settings/api-key', {
      method: 'POST',
    });
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings action fallback to local dev store:', error);
      const current = getDevSettingsStore();
      return setDevSettingsStore({
        ...current,
        apiKey: buildDevApiKey(),
      });
    }

    console.error('Failed to execute action:', error);
    throw new Error('Failed to execute action');
  }
}

/**
 * 全データ削除
 *
 * バックエンド API を試行し、失敗時はローカル dev store にフォールバック
 */
export async function deleteAllData(
  confirmationToken: string,
): Promise<{ success: boolean }> {
  try {
    return await serverApiRequest<{ success: boolean }>(
      '/admin/settings/delete-all-data',
      {
        method: 'POST',
        body: JSON.stringify({ confirmationToken }),
      },
    );
  } catch (error) {
    if (isLocalDevFallbackError(error)) {
      console.warn('Admin settings action fallback to local dev store:', error);
      clearDevEvents();
      return { success: true };
    }

    console.error('Failed to execute action:', error);
    throw new Error('Failed to execute action');
  }
}
