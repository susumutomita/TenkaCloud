import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.fn();
const getCurrentIdTokenMock = vi.fn();

vi.mock('@/lib/runtime-config', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('@/lib/auth/cognito-pkce', () => ({
  getCurrentIdToken: getCurrentIdTokenMock,
}));

const cloudConfig = {
  adminApiUrl: 'https://admin.example.com',
  apiBaseUrl: 'https://sbt.example.com',
  cognitoDomain: 'https://cognito.example.com',
  cognitoClientId: 'client-id',
  redirectUri: 'https://app/callback',
  scope: 'openid',
};

describe('admin-api-client', () => {
  const originalEnv = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    global.fetch = vi.fn().mockResolvedValue(new Response('{}'));
    loadConfigMock.mockResolvedValue(cloudConfig);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
    }
  });

  it('cloud では adminApiUrl + path-prefix を使用してリクエストすべき', async () => {
    getCurrentIdTokenMock.mockResolvedValue('id-token-abc');

    const { adminFetch } = await import('../admin-api-client');
    await adminFetch('tenant-management', '/api/stats');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://admin.example.com/tenant-management/api/stats',
      expect.objectContaining({
        headers: { Authorization: 'Bearer id-token-abc' },
      }),
    );
  });

  it('skipAuth=true の場合は Authorization ヘッダーを付けないべき', async () => {
    const { adminFetch } = await import('../admin-api-client');
    await adminFetch('problem-service', '/health', { skipAuth: true });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://admin.example.com/problem/health',
      expect.objectContaining({ headers: {} }),
    );
    expect(getCurrentIdTokenMock).not.toHaveBeenCalled();
  });

  it('dev fallback で NEXT_PUBLIC_TENANT_API_BASE_URL を使用すべき (tenant-management のみ)', async () => {
    process.env.NEXT_PUBLIC_TENANT_API_BASE_URL = 'http://localhost:13004';

    const { adminFetch } = await import('../admin-api-client');
    await adminFetch('tenant-management', '/api/stats');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:13004/api/stats',
      expect.objectContaining({ headers: {} }),
    );
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it('runtime-config に adminApiUrl が無い場合はエラーを投げるべき', async () => {
    loadConfigMock.mockResolvedValue({
      ...cloudConfig,
      adminApiUrl: undefined,
    });

    const { adminFetch } = await import('../admin-api-client');
    await expect(adminFetch('gameday-service', '/api/games')).rejects.toThrow(
      /adminApiUrl is not configured/,
    );
  });

  it('Cognito token が無い場合は Authorization ヘッダーを付けないべき', async () => {
    getCurrentIdTokenMock.mockResolvedValue(null);

    const { adminFetch } = await import('../admin-api-client');
    await adminFetch('battle-service', '/api/battles');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://admin.example.com/battle/api/battles',
      expect.objectContaining({ headers: {} }),
    );
  });

  it('追加の headers をマージすべき', async () => {
    getCurrentIdTokenMock.mockResolvedValue('tok');

    const { adminFetch } = await import('../admin-api-client');
    await adminFetch('scoring-service', '/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"x":1}',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://admin.example.com/scoring/api/score',
      expect.objectContaining({
        method: 'POST',
        body: '{"x":1}',
        headers: {
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        },
      }),
    );
  });
});
