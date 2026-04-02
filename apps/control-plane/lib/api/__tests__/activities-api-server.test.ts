/**
 * @vitest-environment node
 *
 * このテストファイルは activities-api.ts のサーバーサイドブランチをテストします。
 * node 環境では window が未定義のため、サーバーサイドのコードパスがカバーされます。
 */
import { describe, expect, it, vi } from 'vitest';

describe('activities-api サーバーサイドテスト', () => {
  it('node 環境では window が未定義であるべき', () => {
    expect(typeof window).toBe('undefined');
  });

  it('TENANT_API_BASE_URL が設定されている場合それを使用すべき', async () => {
    vi.resetModules();

    const originalEnv = process.env.TENANT_API_BASE_URL;
    process.env.TENANT_API_BASE_URL = 'http://custom-server-api:13004/api';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [],
          pagination: { limit: 10, hasNextPage: false },
        }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchActivities } = await import('../activities-api');
      await fetchActivities();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-server-api:13004/api/activities?limit=10',
        { cache: 'no-store' }
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
      json: () =>
        Promise.resolve({
          data: [],
          pagination: { limit: 10, hasNextPage: false },
        }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchActivities } = await import('../activities-api');
      await fetchActivities();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://tenant-management:13004/api/activities?limit=10',
        { cache: 'no-store' }
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.TENANT_API_BASE_URL = originalEnv;
      }
    }
  });
});
