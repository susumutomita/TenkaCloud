import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('service-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('TENANT_API_BASE_URL が localhost の場合は localhost のヘルス URL を優先すべき', async () => {
    vi.stubEnv('TENANT_API_BASE_URL', 'http://localhost:13004/api');

    const { resolveServiceHealthUrls } = await import('../service-health');

    expect(resolveServiceHealthUrls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tenant-management',
          checkedUrl: 'http://localhost:13004/health',
        }),
        expect.objectContaining({
          id: 'problem-service',
          checkedUrl: 'http://localhost:3100/health',
        }),
      ]),
    );
  });

  it('環境変数が未設定の場合は Docker 向け URL を優先すべき', async () => {
    const { resolveServiceHealthUrls } = await import('../service-health');

    expect(resolveServiceHealthUrls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tenant-management',
          checkedUrl: 'http://tenant-management:13004/health',
        }),
        expect.objectContaining({
          id: 'leaderboard-service',
          checkedUrl: 'http://leaderboard-service:3012/health',
        }),
      ]),
    );
  });

  it('個別のヘルス URL 環境変数がある場合はその URL を使用すべき', async () => {
    vi.stubEnv(
      'PROBLEM_SERVICE_HEALTH_URL',
      'http://custom-problem-service.internal/health',
    );

    const { resolveServiceHealthUrls } = await import('../service-health');

    expect(resolveServiceHealthUrls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'problem-service',
          checkedUrl: 'http://custom-problem-service.internal/health',
        }),
      ]),
    );
  });

  it('127.0.0.1 の場合も localhost 扱いで優先すべき', async () => {
    vi.stubEnv('TENANT_API_BASE_URL', 'http://127.0.0.1:13004/api');

    const { resolveServiceHealthUrls } = await import('../service-health');

    expect(resolveServiceHealthUrls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gameday-service',
          checkedUrl: 'http://localhost:3020/health',
        }),
      ]),
    );
  });

  it('NEXT_PUBLIC_TENANT_API_BASE_URL が localhost の場合も localhost のヘルス URL を優先すべき', async () => {
    vi.stubEnv('NEXT_PUBLIC_TENANT_API_BASE_URL', 'http://localhost:13004/api');

    const { resolveServiceHealthUrls } = await import('../service-health');

    expect(resolveServiceHealthUrls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'battle-service',
          checkedUrl: 'http://localhost:3010/health',
        }),
      ]),
    );
  });

  it('最初の候補に失敗しても代替 URL で接続できれば接続中と判定すべき', async () => {
    vi.stubEnv('TENANT_API_BASE_URL', 'http://localhost:13004/api');
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url.includes('localhost')) {
        return Promise.reject(new Error('connect ECONNREFUSED'));
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'tenant-management' }),
      });
    }) as unknown as typeof fetch;

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();
    const tenantService = services.find(
      (service) => service.id === 'tenant-management',
    );

    expect(tenantService).toEqual(
      expect.objectContaining({
        status: 'connected',
        checkedUrl: 'http://tenant-management:13004/health',
        detail: 'tenant-management',
      }),
    );
  });

  it('HTTP エラーを返したサービスは未接続と判定すべき', async () => {
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url.includes('problem-service') || url.includes('localhost:3100')) {
        return Promise.resolve({
          ok: false,
          status: 503,
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'healthy-service' }),
      });
    }) as unknown as typeof fetch;

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();
    const problemService = services.find(
      (service) => service.id === 'problem-service',
    );

    expect(problemService).toEqual(
      expect.objectContaining({
        status: 'unreachable',
        detail: 'HTTP 503',
      }),
    );
  });

  it('unhealthy な payload を返した場合は代替 URL を試すべき', async () => {
    vi.stubEnv('TENANT_API_BASE_URL', 'http://localhost:13004/api');
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url === 'http://localhost:3100/health') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'degraded' }),
        });
      }

      if (url === 'http://problem-service:3100/health') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ status: 'healthy', service: 'problem-service' }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'healthy-service' }),
      });
    }) as unknown as typeof fetch;

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();
    const problemService = services.find(
      (service) => service.id === 'problem-service',
    );

    expect(problemService).toEqual(
      expect.objectContaining({
        status: 'connected',
        checkedUrl: 'http://problem-service:3100/health',
        detail: 'problem-service',
      }),
    );
  });

  it('status が null の payload は unhealthy として扱うべき', async () => {
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url.includes('problem-service') || url.includes('localhost:3100')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: null }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'healthy-service' }),
      });
    }) as unknown as typeof fetch;

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();
    const problemService = services.find(
      (service) => service.id === 'problem-service',
    );

    expect(problemService).toEqual(
      expect.objectContaining({
        status: 'unreachable',
        detail: 'unhealthy',
      }),
    );
  });

  it('個別のヘルス URL 環境変数がある場合はその URL だけを使うべき', async () => {
    vi.stubEnv(
      'PROBLEM_SERVICE_HEALTH_URL',
      'http://custom-problem-service.internal/health',
    );
    global.fetch = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);

      if (url === 'http://custom-problem-service.internal/health') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('invalid json')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'ok', service: 'healthy-service' }),
      });
    }) as unknown as typeof fetch;

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();
    const problemService = services.find(
      (service) => service.id === 'problem-service',
    );

    expect(problemService).toEqual(
      expect.objectContaining({
        status: 'connected',
        checkedUrl: 'http://custom-problem-service.internal/health',
        detail: undefined,
      }),
    );
  });

  it('全候補に失敗した場合は未接続と判定すべき', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();

    expect(services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'problem-service',
          status: 'unreachable',
          detail: 'fetch failed',
        }),
      ]),
    );
  });

  it('接続状況から全体ステータスを集計すべき', async () => {
    const { summarizeServiceConnections } = await import('../service-health');

    expect(
      summarizeServiceConnections([
        {
          id: 'tenant-management',
          name: 'Tenant Management',
          status: 'connected',
          checkedUrl: 'http://tenant-management:13004/health',
        },
      ]),
    ).toBe('healthy');

    expect(
      summarizeServiceConnections([
        {
          id: 'tenant-management',
          name: 'Tenant Management',
          status: 'connected',
          checkedUrl: 'http://tenant-management:13004/health',
        },
        {
          id: 'problem-service',
          name: 'Problem Service',
          status: 'unreachable',
          checkedUrl: 'http://problem-service:3100/health',
        },
      ]),
    ).toBe('degraded');

    expect(
      summarizeServiceConnections([
        {
          id: 'tenant-management',
          name: 'Tenant Management',
          status: 'unreachable',
          checkedUrl: 'http://tenant-management:13004/health',
        },
      ]),
    ).toBe('down');
  });

  it('Error 以外で失敗した場合は Unknown error として扱うべき', async () => {
    global.fetch = vi.fn().mockRejectedValue('boom');

    const { fetchServiceConnections } = await import('../service-health');
    const services = await fetchServiceConnections();

    expect(services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tenant-management',
          status: 'unreachable',
          detail: 'Unknown error',
        }),
      ]),
    );
  });

  it('AbortSignal.timeout が使えない場合でもヘルスチェックできるべき', async () => {
    vi.stubGlobal('AbortSignal', undefined);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ status: 'ok', service: 'tenant-management' }),
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    const { fetchServiceConnections } = await import('../service-health');
    await fetchServiceConnections();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://tenant-management:13004/health',
      { cache: 'no-store' },
    );

    vi.unstubAllGlobals();
  });

  describe('cloud (adminApiUrl 設定済み)', () => {
    beforeEach(() => {
      vi.doMock('@/lib/runtime-config', () => ({
        loadConfig: vi.fn().mockResolvedValue({
          adminApiUrl: 'https://admin.example.com',
          apiBaseUrl: 'https://sbt.example.com',
          cognitoDomain: 'https://cognito.example.com',
          cognitoClientId: 'cid',
          redirectUri: 'https://x/callback',
          scope: 'openid',
        }),
      }));
    });

    it('cloud では adminFetch 経由で /<service>/health を呼ぶべき', async () => {
      const adminFetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: 'ok', service: 'tenant-management' }),
            { status: 200 },
          ),
        );
      vi.doMock('../admin-api-client', () => ({ adminFetch: adminFetchMock }));

      const { fetchServiceConnections } = await import('../service-health');
      const services = await fetchServiceConnections();

      expect(adminFetchMock).toHaveBeenCalledWith(
        'tenant-management',
        '/health',
        expect.objectContaining({ skipAuth: true }),
      );
      expect(services.find((s) => s.id === 'tenant-management')?.status).toBe(
        'connected',
      );
    });

    it('cloud で 5xx を返したら unreachable にすべき', async () => {
      const adminFetchMock = vi
        .fn()
        .mockResolvedValue(new Response('err', { status: 500 }));
      vi.doMock('../admin-api-client', () => ({ adminFetch: adminFetchMock }));

      const { fetchServiceConnections } = await import('../service-health');
      const services = await fetchServiceConnections();

      expect(services.find((s) => s.id === 'problem-service')).toMatchObject({
        status: 'unreachable',
        detail: 'HTTP 500',
      });
    });

    it('cloud で fetch 例外時に unreachable にすべき', async () => {
      const adminFetchMock = vi.fn().mockRejectedValue(new Error('network'));
      vi.doMock('../admin-api-client', () => ({ adminFetch: adminFetchMock }));

      const { fetchServiceConnections } = await import('../service-health');
      const services = await fetchServiceConnections();

      expect(services.every((s) => s.status === 'unreachable')).toBe(true);
      expect(services[0].detail).toBe('network');
    });

    it('cloud で fetch が Error 以外で reject した場合は Unknown error にすべき', async () => {
      const adminFetchMock = vi.fn().mockRejectedValue('boom');
      vi.doMock('../admin-api-client', () => ({ adminFetch: adminFetchMock }));

      const { fetchServiceConnections } = await import('../service-health');
      const services = await fetchServiceConnections();

      expect(services[0].detail).toBe('Unknown error');
    });
  });
});
