/**
 * @vitest-environment jsdom
 *
 * このテストファイルは stats-api.ts のクライアントサイドブランチをテストします。
 * jsdom 環境では window が定義されているため、クライアントサイドのコードパスがカバーされます。
 */
import { describe, expect, it, vi } from 'vitest';

describe('stats-api クライアントサイドテスト', () => {
  it('jsdom 環境では window が定義されているべき', () => {
    expect(typeof window).not.toBe('undefined');
  });

  it('NEXT_PUBLIC_TENANT_API_BASE_URL が設定されている場合それを使用すべき', async () => {
    vi.resetModules();

    const originalEnv = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    process.env.NEXT_PUBLIC_TENANT_API_BASE_URL =
      'http://custom-client-api:13004/api';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          activeTenants: 0,
          totalTenants: 0,
          systemStatus: 'healthy',
          uptimePercentage: 100,
        }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchDashboardStats } = await import('../stats-api');
      await fetchDashboardStats();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-client-api:13004/api/stats',
        { cache: 'no-store' },
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
      } else {
        process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = originalEnv;
      }
    }
  });

  it('NEXT_PUBLIC_TENANT_API_BASE_URL 未設定時はデフォルト URL を使用すべき', async () => {
    vi.resetModules();

    const originalEnv = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          activeTenants: 0,
          totalTenants: 0,
          systemStatus: 'healthy',
          uptimePercentage: 100,
        }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    try {
      const { fetchDashboardStats } = await import('../stats-api');
      await fetchDashboardStats();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:13004/api/stats',
        { cache: 'no-store' },
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = originalEnv;
      }
    }
  });
});
