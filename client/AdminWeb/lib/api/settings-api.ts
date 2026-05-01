import type { Settings } from '@/types/settings';
import { DEFAULT_SETTINGS } from '@/types/settings';
import { adminFetch } from './admin-api-client';

export async function fetchSettings(): Promise<Settings> {
  const res = await adminFetch('tenant-management', '/api/settings', {
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch settings: ${res.status}`);
  }

  return res.json() as Promise<Settings>;
}

export async function getSettings(): Promise<Settings> {
  try {
    return await fetchSettings();
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const res = await adminFetch('tenant-management', '/api/settings', {
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
