import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Stats API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('サーバーサイド（window がない場合）', () => {
    it('ダッシュボード統計を取得できるべき', async () => {
      // Remove window to simulate server-side
      vi.stubGlobal('window', undefined);

      const { fetchDashboardStats } = await import('../stats-api');

      const mockStats = {
        activeTenants: 5,
        totalTenants: 10,
        systemStatus: 'healthy',
        uptimePercentage: 99.9,
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStats),
      });

      const result = await fetchDashboardStats();

      expect(result).toEqual(mockStats);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/stats'),
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });

    it('APIエラー時に例外をスローすべき', async () => {
      vi.stubGlobal('window', undefined);

      const { fetchDashboardStats } = await import('../stats-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetchDashboardStats()).rejects.toThrow(
        'Failed to fetch stats: 500'
      );

      vi.unstubAllGlobals();
    });

    it('環境変数が設定されている場合はそれを使用すべき', async () => {
      vi.stubGlobal('window', undefined);
      vi.stubEnv('TENANT_API_BASE_URL', 'http://custom-api:8080/api');

      const { fetchDashboardStats } = await import('../stats-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            activeTenants: 0,
            totalTenants: 0,
            systemStatus: 'healthy',
            uptimePercentage: 100,
          }),
      });

      await fetchDashboardStats();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-api:8080/api/stats',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
  });

  describe('クライアントサイド（window がある場合）', () => {
    it('クライアント環境変数を使用すべき', async () => {
      vi.stubGlobal('window', {});
      vi.stubEnv(
        'NEXT_PUBLIC_TENANT_API_BASE_URL',
        'http://client-api:9000/api'
      );

      const { fetchDashboardStats } = await import('../stats-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            activeTenants: 0,
            totalTenants: 0,
            systemStatus: 'healthy',
            uptimePercentage: 100,
          }),
      });

      await fetchDashboardStats();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://client-api:9000/api/stats',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('クライアント環境変数が未設定の場合はデフォルトを使用すべき', async () => {
      vi.stubGlobal('window', {});

      const { fetchDashboardStats } = await import('../stats-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            activeTenants: 0,
            totalTenants: 0,
            systemStatus: 'healthy',
            uptimePercentage: 100,
          }),
      });

      await fetchDashboardStats();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3004/api/stats',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });
  });
});
