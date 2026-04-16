import { describe, expect, it, afterEach, vi } from 'vitest';

describe('Backend URL ヘルパー', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  describe('getProblemServiceUrl', () => {
    it('API_URL が設定されている場合はそれを返すべき', async () => {
      process.env.API_URL = 'http://custom:4000/api';
      process.env.NEXT_PUBLIC_API_URL = 'http://public:4000/api';
      const { getProblemServiceUrl } = await import('../backend-urls');
      expect(getProblemServiceUrl()).toBe('http://custom:4000/api');
    });

    it('API_URL がなく NEXT_PUBLIC_API_URL がある場合はフォールバックすべき', async () => {
      process.env.API_URL = '';
      process.env.NEXT_PUBLIC_API_URL = 'http://public:4000/api';
      const { getProblemServiceUrl } = await import('../backend-urls');
      expect(getProblemServiceUrl()).toBe('http://public:4000/api');
    });

    it('環境変数がない場合はデフォルト URL を返すべき', async () => {
      process.env.API_URL = '';
      process.env.NEXT_PUBLIC_API_URL = '';
      const { getProblemServiceUrl } = await import('../backend-urls');
      expect(getProblemServiceUrl()).toBe('http://localhost:3100/api');
    });
  });

  describe('getGamedayApiUrl', () => {
    it('GAMEDAY_API_URL が設定されている場合はそれを返すべき', async () => {
      process.env.GAMEDAY_API_URL = 'http://gameday:5000/api/gameday';
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL =
        'http://public-gd:5000/api/gameday';
      const { getGamedayApiUrl } = await import('../backend-urls');
      expect(getGamedayApiUrl()).toBe('http://gameday:5000/api/gameday');
    });

    it('GAMEDAY_API_URL がなく NEXT_PUBLIC_GAMEDAY_API_URL がある場合はフォールバックすべき', async () => {
      process.env.GAMEDAY_API_URL = '';
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL =
        'http://public-gd:5000/api/gameday';
      const { getGamedayApiUrl } = await import('../backend-urls');
      expect(getGamedayApiUrl()).toBe('http://public-gd:5000/api/gameday');
    });

    it('環境変数がない場合はデフォルト URL を返すべき', async () => {
      process.env.GAMEDAY_API_URL = '';
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL = '';
      const { getGamedayApiUrl } = await import('../backend-urls');
      expect(getGamedayApiUrl()).toBe('http://localhost:3020/api/gameday');
    });
  });

  describe('getTenantServiceUrl', () => {
    it('TENANT_SERVICE_URL が設定されている場合はそれを返すべき', async () => {
      process.env.TENANT_SERVICE_URL = 'http://tenant:6000/api/tenant';
      const { getTenantServiceUrl } = await import('../backend-urls');
      expect(getTenantServiceUrl()).toBe('http://tenant:6000/api/tenant');
    });

    it('環境変数がない場合はデフォルト URL を返すべき', async () => {
      process.env.TENANT_SERVICE_URL = '';
      const { getTenantServiceUrl } = await import('../backend-urls');
      expect(getTenantServiceUrl()).toBe('http://localhost:3200/api/tenant');
    });
  });

  describe('getLeaderboardApiUrl', () => {
    it('LEADERBOARD_API_URL が設定されている場合はそれを返すべき', async () => {
      process.env.LEADERBOARD_API_URL = 'http://leaderboard:3012';
      process.env.NEXT_PUBLIC_LEADERBOARD_API_URL = 'http://public-lb:3012';
      const { getLeaderboardApiUrl } = await import('../backend-urls');
      expect(getLeaderboardApiUrl()).toBe('http://leaderboard:3012');
    });

    it('LEADERBOARD_API_URL がなく NEXT_PUBLIC_LEADERBOARD_API_URL がある場合はフォールバックすべき', async () => {
      process.env.LEADERBOARD_API_URL = '';
      process.env.NEXT_PUBLIC_LEADERBOARD_API_URL = 'http://public-lb:3012';
      const { getLeaderboardApiUrl } = await import('../backend-urls');
      expect(getLeaderboardApiUrl()).toBe('http://public-lb:3012');
    });

    it('環境変数がない場合はデフォルト URL を返すべき', async () => {
      process.env.LEADERBOARD_API_URL = '';
      process.env.NEXT_PUBLIC_LEADERBOARD_API_URL = '';
      const { getLeaderboardApiUrl } = await import('../backend-urls');
      expect(getLeaderboardApiUrl()).toBe('http://localhost:3012');
    });
  });

  describe('getAllServiceUrls', () => {
    it('全サービスの URL マップを返すべき', async () => {
      process.env.API_URL = 'http://problem:3100/api';
      process.env.GAMEDAY_API_URL = 'http://gameday:3020/api/gameday';
      process.env.LEADERBOARD_API_URL = 'http://leaderboard:3012';
      process.env.TENANT_SERVICE_URL = 'http://tenant:3200/api/tenant';
      const { getAllServiceUrls } = await import('../backend-urls');

      const urls = getAllServiceUrls();
      expect(urls).toEqual({
        'problem-service': 'http://problem:3100/api',
        'gameday-service': 'http://gameday:3020/api/gameday',
        'leaderboard-service': 'http://leaderboard:3012',
        'tenant-management': 'http://tenant:3200/api/tenant',
      });
    });

    it('デフォルト値を含むマップを返すべき', async () => {
      process.env.API_URL = '';
      process.env.NEXT_PUBLIC_API_URL = '';
      process.env.GAMEDAY_API_URL = '';
      process.env.NEXT_PUBLIC_GAMEDAY_API_URL = '';
      process.env.LEADERBOARD_API_URL = '';
      process.env.NEXT_PUBLIC_LEADERBOARD_API_URL = '';
      process.env.TENANT_SERVICE_URL = '';
      const { getAllServiceUrls } = await import('../backend-urls');

      const urls = getAllServiceUrls();
      expect(Object.keys(urls)).toEqual([
        'problem-service',
        'gameday-service',
        'leaderboard-service',
        'tenant-management',
      ]);
      expect(urls['problem-service']).toBe('http://localhost:3100/api');
      expect(urls['gameday-service']).toBe('http://localhost:3020/api/gameday');
      expect(urls['leaderboard-service']).toBe('http://localhost:3012');
      expect(urls['tenant-management']).toBe(
        'http://localhost:3200/api/tenant',
      );
    });
  });
});
