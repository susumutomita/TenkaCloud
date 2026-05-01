import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../runtime-config';

describe('runtime-config', () => {
  beforeEach(() => {
    resetConfigCache();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: new URL('https://app.example.com'),
    });
    delete process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
    delete process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_COGNITO_SCOPE;
    delete process.env.NEXT_PUBLIC_BASE_PATH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runtime-config.json から設定を読むべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apiUrl: 'https://api.example.com/',
            cognitoDomain: 'https://cognito.example.com',
            userClientId: 'client-id-123',
          }),
          { status: 200 },
        ),
      ),
    );

    const config = await loadConfig();

    expect(config.cognitoDomain).toBe('https://cognito.example.com');
    expect(config.cognitoClientId).toBe('client-id-123');
    expect(config.apiBaseUrl).toBe('https://api.example.com');
    expect(config.redirectUri).toContain('/callback');
    expect(config.scope).toBe('openid email profile');
  });

  it('結果を cache すべき', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiUrl: 'https://api.example.com',
          cognitoDomain: 'https://cognito.example.com',
          userClientId: 'cid',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await loadConfig();
    await loadConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('同時呼び出しでも fetch は 1 回だけにすべき', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiUrl: 'https://api.example.com',
          cognitoDomain: 'https://cognito.example.com',
          userClientId: 'cid',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([loadConfig(), loadConfig(), loadConfig()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runtime-config.json が空欄を含むなら dev fallback に行くべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ apiUrl: 'x' }), { status: 200 }),
        ),
    );
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN = 'https://dev-cognito.example.com';
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = 'dev-cid';
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://dev-api.example.com';

    const config = await loadConfig();

    expect(config.cognitoDomain).toBe('https://dev-cognito.example.com');
    expect(config.cognitoClientId).toBe('dev-cid');
    expect(config.apiBaseUrl).toBe('https://dev-api.example.com');
  });

  it('runtime-config が 404 で env も無いと throw すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 404 })),
    );
    await expect(loadConfig()).rejects.toThrow(/Runtime config not found/);
  });

  it('fetch 例外時も dev fallback できるべき', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN = 'https://dev.example.com';
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = 'cid';
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';

    const config = await loadConfig();

    expect(config.cognitoDomain).toBe('https://dev.example.com');
  });

  it('runtime-config の adminApiUrl を transparently 公開すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apiUrl: 'https://api.example.com',
            cognitoDomain: 'https://cognito.example.com',
            userClientId: 'cid',
            adminApiUrl: 'https://admin-api.example.com/',
          }),
          { status: 200 },
        ),
      ),
    );

    const config = await loadConfig();

    expect(config.adminApiUrl).toBe('https://admin-api.example.com');
  });

  it('dev fallback で NEXT_PUBLIC_ADMIN_API_BASE_URL を使うべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 404 })),
    );
    process.env.NEXT_PUBLIC_COGNITO_DOMAIN = 'https://dev.example.com';
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID = 'cid';
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL = 'http://localhost:13004';

    const config = await loadConfig();

    expect(config.adminApiUrl).toBe('http://localhost:13004');

    delete process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL;
  });

  it('NEXT_PUBLIC_COGNITO_SCOPE で scope を上書きできるべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apiUrl: 'https://api.example.com',
            cognitoDomain: 'https://cognito.example.com',
            userClientId: 'cid',
          }),
          { status: 200 },
        ),
      ),
    );
    process.env.NEXT_PUBLIC_COGNITO_SCOPE = 'openid';

    const config = await loadConfig();

    expect(config.scope).toBe('openid');
  });
});
