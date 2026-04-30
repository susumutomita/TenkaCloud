import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = 'http://localhost:13004/api';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
});

describe('tenant-api (local fallback)', () => {
  it('listTenants は paginated レスポンスから data を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: 't1', name: 'A' }], pagination: {} }),
        { status: 200 },
      ),
    );
    const { tenantApi } = await import('../tenant-api');
    const tenants = await tenantApi.listTenants();
    expect(tenants).toEqual([{ id: 't1', name: 'A' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:13004/api/tenants',
      expect.any(Object),
    );
  });

  it('getTenant は 404 で null を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.getTenant('missing')).toBeNull();
  });

  it('getTenant は 200 で tenant を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 't1', name: 'A' }), { status: 200 }),
    );
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.getTenant('t1')).toEqual({ id: 't1', name: 'A' });
  });

  it('createTenant は POST すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 't1' }), { status: 200 }),
    );
    const { tenantApi } = await import('../tenant-api');
    await tenantApi.createTenant({
      name: 'A',
      slug: 'a',
      adminEmail: 'a@e.com',
      tier: 'FREE',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:13004/api/tenants',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('updateTenant は PATCH すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 't1' }), { status: 200 }),
    );
    const { tenantApi } = await import('../tenant-api');
    await tenantApi.updateTenant('t1', { name: 'B' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:13004/api/tenants/t1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('updateTenant は 404 で null を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.updateTenant('missing', { name: 'B' })).toBeNull();
  });

  it('deleteTenant は 200 で true を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.deleteTenant('t1')).toBe(true);
  });

  it('deleteTenant は 404 で false を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.deleteTenant('missing')).toBe(false);
  });

  it('triggerProvisioning は POST すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          message: 'ok',
          provisioningStatus: 'IN_PROGRESS',
        }),
        { status: 200 },
      ),
    );
    const { tenantApi } = await import('../tenant-api');
    const result = await tenantApi.triggerProvisioning('t1');
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:13004/api/tenants/t1/provision',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('getProvisioningStatus は 404 で null を返すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { tenantApi } = await import('../tenant-api');
    expect(await tenantApi.getProvisioningStatus('t1')).toBeNull();
  });

  it('TenantApiError は API エラーメッセージを伝搬すべき', async () => {
    const { TenantApiError } = await import('../tenant-api');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '不正な入力' }), { status: 400 }),
    );
    const { tenantApi } = await import('../tenant-api');
    await expect(
      tenantApi.createTenant({
        name: 'A',
        slug: 'a',
        adminEmail: 'a@e.com',
        tier: 'FREE',
      }),
    ).rejects.toBeInstanceOf(TenantApiError);
  });

  it('error.message スタイルのエラーを userMessage に伝搬すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: '権限エラー' } }), {
        status: 403,
      }),
    );
    const { tenantApi } = await import('../tenant-api');
    await expect(tenantApi.listTenants()).rejects.toMatchObject({
      userMessage: '権限エラー',
    });
  });

  it('error が文字列スタイルのエラーを userMessage に伝搬すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    const { tenantApi } = await import('../tenant-api');
    await expect(tenantApi.listTenants()).rejects.toMatchObject({
      userMessage: 'forbidden',
    });
  });

  it('JSON でないエラーレスポンスはデフォルトメッセージを使うべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));
    const { tenantApi } = await import('../tenant-api');
    await expect(tenantApi.listTenants()).rejects.toMatchObject({
      userMessage: 'APIリクエストに失敗しました',
    });
  });

  it('error / message いずれも無い JSON はデフォルトメッセージを使うべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ otherField: 'x' }), { status: 500 }),
    );
    const { tenantApi } = await import('../tenant-api');
    await expect(tenantApi.listTenants()).rejects.toMatchObject({
      userMessage: 'APIリクエストに失敗しました',
    });
  });

  it('getProvisioningStatus は 200 でデータを返すべき', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tenantId: 't1',
          provisioningStatus: 'COMPLETED',
          provisioningEnabled: true,
        }),
        { status: 200 },
      ),
    );
    const { tenantApi } = await import('../tenant-api');
    const result = await tenantApi.getProvisioningStatus('t1');
    expect(result?.tenantId).toBe('t1');
  });

  it('複数回呼んでも resolveApi は 1 回しか初期化しないべき', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
    );
    const { tenantApi } = await import('../tenant-api');
    await tenantApi.listTenants();
    await tenantApi.listTenants();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('同時呼び出しでも resolveApi は 1 回しか初期化しないべき', async () => {
    let resolveFetch!: () => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = () =>
        resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    });
    fetchMock
      .mockImplementationOnce(() => fetchPromise)
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
      );

    const { tenantApi } = await import('../tenant-api');
    const p1 = tenantApi.listTenants();
    const p2 = tenantApi.listTenants();
    const p3 = tenantApi.listTenants();
    resolveFetch();
    await Promise.all([p1, p2, p3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('tenant-api (SBT runtime-config branch)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
  });

  it('runtime-config が無いと throw すべき', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { tenantApi } = await import('../tenant-api');
    await expect(tenantApi.listTenants()).rejects.toThrow(
      /Runtime config not found/,
    );
  });

  it('runtime-config の SBT API を listTenants に使うべき', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/runtime-config.json') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              apiUrl: 'https://sbt.example.com',
              cognitoDomain: 'https://cognito.example.com',
              userClientId: 'cid',
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    const { tenantApi } = await import('../tenant-api');
    await tenantApi.listTenants();

    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).startsWith('https://sbt.example.com/tenants'),
      ),
    ).toBe(true);
  });

  it('SBT 初期化中の同時呼び出しは inflight を共有すべき', async () => {
    // runtime-config を deferred にして resolveApi の inflight 経路を踏ませる
    let resolveConfig!: () => void;
    const configPromise = new Promise<Response>((resolve) => {
      resolveConfig = () =>
        resolve(
          new Response(
            JSON.stringify({
              apiUrl: 'https://sbt.example.com',
              cognitoDomain: 'https://cognito.example.com',
              userClientId: 'cid',
            }),
            { status: 200 },
          ),
        );
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === '/runtime-config.json') return configPromise;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    });

    const { tenantApi } = await import('../tenant-api');
    const p1 = tenantApi.listTenants();
    const p2 = tenantApi.listTenants();
    resolveConfig();
    await Promise.all([p1, p2]);

    const configCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === '/runtime-config.json',
    );
    expect(configCalls).toHaveLength(1);
  });
});
