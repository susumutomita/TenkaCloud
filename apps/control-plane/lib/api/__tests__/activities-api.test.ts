import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Activities API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('サーバーサイド（window がない場合）', () => {
    it('アクティビティを取得できるべき', async () => {
      vi.stubGlobal('window', undefined);

      const { fetchActivities } = await import('../activities-api');

      const mockActivities = {
        data: [
          {
            id: '01J123ABC',
            action: 'CREATE',
            resourceType: 'TENANT',
            resourceId: '01J456DEF',
            details: { name: 'Test Tenant' },
            timestamp: '2025-01-01T00:00:00.000Z',
          },
        ],
        pagination: {
          limit: 10,
          hasNextPage: false,
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockActivities),
      });

      const result = await fetchActivities();

      expect(result).toEqual(mockActivities);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/activities?limit=10'),
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });

    it('カスタム limit を指定できるべき', async () => {
      vi.stubGlobal('window', undefined);

      const { fetchActivities } = await import('../activities-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [],
            pagination: { limit: 5, hasNextPage: false },
          }),
      });

      await fetchActivities(5);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/activities?limit=5'),
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });

    it('APIエラー時に例外をスローすべき', async () => {
      vi.stubGlobal('window', undefined);

      const { fetchActivities } = await import('../activities-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetchActivities()).rejects.toThrow(
        'Failed to fetch activities: 500'
      );

      vi.unstubAllGlobals();
    });

    it('環境変数が設定されている場合はそれを使用すべき', async () => {
      vi.stubGlobal('window', undefined);
      vi.stubEnv('TENANT_API_BASE_URL', 'http://custom-api:8080/api');

      const { fetchActivities } = await import('../activities-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [],
            pagination: { limit: 10, hasNextPage: false },
          }),
      });

      await fetchActivities();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-api:8080/api/activities?limit=10',
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

      const { fetchActivities } = await import('../activities-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [],
            pagination: { limit: 10, hasNextPage: false },
          }),
      });

      await fetchActivities();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://client-api:9000/api/activities?limit=10',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('クライアント環境変数が未設定の場合はデフォルトを使用すべき', async () => {
      vi.stubGlobal('window', {});

      const { fetchActivities } = await import('../activities-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [],
            pagination: { limit: 10, hasNextPage: false },
          }),
      });

      await fetchActivities();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:13004/api/activities?limit=10',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });
  });
});
