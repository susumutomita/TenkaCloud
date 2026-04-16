/**
 * @vitest-environment node
 *
 * このテストファイルは settings-api.ts のサーバーサイドブランチをテストします。
 * node 環境では window が未定義のため、サーバーサイドのコードパスがカバーされます。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types/settings';

describe('settings-api サーバーサイドテスト', () => {
  it('node 環境では window が未定義であるべき', () => {
    expect(typeof window).toBe('undefined');
  });

  it('TENANT_API_BASE_URL が設定されている場合それを使用すべき', async () => {
    vi.resetModules();

    const originalEnv = process.env.TENANT_API_BASE_URL;
    process.env.TENANT_API_BASE_URL = 'http://custom-server-api:13004/api';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(DEFAULT_SETTINGS),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchSettings } = await import('../settings-api');
      await fetchSettings();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-server-api:13004/api/settings',
        { cache: 'no-store' },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TENANT_API_BASE_URL;
      } else {
        process.env.TENANT_API_BASE_URL = originalEnv;
      }
    }
  });

  it('TENANT_API_BASE_URL 未設定時はデフォルト URL を使用すべき', async () => {
    vi.resetModules();

    const originalEnv = process.env.TENANT_API_BASE_URL;
    delete process.env.TENANT_API_BASE_URL;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(DEFAULT_SETTINGS),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchSettings } = await import('../settings-api');
      await fetchSettings();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://tenant-management:13004/api/settings',
        { cache: 'no-store' },
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.TENANT_API_BASE_URL = originalEnv;
      }
    }
  });
});
