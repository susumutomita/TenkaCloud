import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetchMock = vi.fn();
vi.mock('../admin-api-client', () => ({
  adminFetch: adminFetchMock,
}));

import { DEFAULT_SETTINGS } from '@/types/settings';

describe('settings-api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchSettings は tenant-management の /api/settings を呼び出すべき', async () => {
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(DEFAULT_SETTINGS), { status: 200 }),
      ),
    );

    const { fetchSettings } = await import('../settings-api');
    const result = await fetchSettings();

    expect(adminFetchMock).toHaveBeenCalledWith(
      'tenant-management',
      '/api/settings',
      { cache: 'no-store' },
    );
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('fetchSettings はエラー時に例外を投げるべき', async () => {
    adminFetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));

    const { fetchSettings } = await import('../settings-api');
    await expect(fetchSettings()).rejects.toThrow(
      /Failed to fetch settings: 500/,
    );
  });

  it('getSettings はエラー時にデフォルトを返すべき', async () => {
    adminFetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));

    const { getSettings } = await import('../settings-api');
    const result = await getSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('saveSettings は PUT で /api/settings を呼ぶべき', async () => {
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    const { saveSettings } = await import('../settings-api');
    await saveSettings(DEFAULT_SETTINGS);

    expect(adminFetchMock).toHaveBeenCalledWith(
      'tenant-management',
      '/api/settings',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(DEFAULT_SETTINGS),
      }),
    );
  });

  it('saveSettings は失敗時に例外を投げるべき', async () => {
    adminFetchMock.mockResolvedValueOnce(new Response('err', { status: 400 }));

    const { saveSettings } = await import('../settings-api');
    await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(
      /Failed to save settings: 400/,
    );
  });
});
