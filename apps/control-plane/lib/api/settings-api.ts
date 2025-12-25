import type { Settings } from '@/types/settings';
import { DEFAULT_SETTINGS } from '@/types/settings';

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:3004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:3004/api';

/**
 * 設定を取得する
 */
export async function fetchSettings(): Promise<Settings> {
  const res = await fetch(`${apiBaseUrl}/settings`, { cache: 'no-store' });

  if (!res.ok) {
    throw new Error(`Failed to fetch settings: ${res.status}`);
  }

  return res.json() as Promise<Settings>;
}

/**
 * 設定を取得する（エラー時はデフォルト値を返す）
 */
export async function getSettings(): Promise<Settings> {
  try {
    return await fetchSettings();
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 設定を保存する
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    throw new Error(`Failed to save settings: ${res.status}`);
  }
}
