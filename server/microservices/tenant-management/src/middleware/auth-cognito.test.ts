import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Logger mock
const mockLoggerFunctions = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  createLogger: vi.fn(() => mockLoggerFunctions),
}));

// jose mock — JWT 検証を制御
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

describe('認証ミドルウェア — Cognito クレーム抽出', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.AUTH_SKIP;
    delete process.env.AUTH_SKIP_ROLES;
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_AUDIENCE;
    delete process.env.JWKS_URI;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
  });

  it('Cognito の custom:tenant_id からテナント ID を抽出すべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: {
        sub: 'cognito-user-1',
        email: 'cognito@example.com',
        name: 'Cognito User',
        'custom:tenant_id': 'cognito-tenant-abc',
        'cognito:groups': ['tenant-admin'],
        iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id',
        aud: '',
        iat: 0,
        exp: 0,
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as CryptoKey,
    });

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer cognito-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('cognito-user-1');
    expect(body.tenantId).toBe('cognito-tenant-abc');
  });

  it('Cognito の cognito:groups からロールを取得すべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: {
        sub: 'cognito-user-2',
        email: 'admin@example.com',
        'custom:tenant_id': 'cognito-tenant-xyz',
        'cognito:groups': ['platform-admin', 'tenant-admin'],
        iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id',
        aud: '',
        iat: 0,
        exp: 0,
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as CryptoKey,
    });

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer cognito-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.roles).toEqual(['platform-admin', 'tenant-admin']);
  });

  it('Cognito クレームが Auth0 クレームより優先されるべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: {
        sub: 'hybrid-user',
        'custom:tenant_id': 'cognito-tenant',
        'https://tenkacloud.com/tenant_id': 'auth0-tenant',
        'cognito:groups': ['cognito-role'],
        'https://tenkacloud.com/roles': ['auth0-role'],
        iss: '',
        aud: '',
        iat: 0,
        exp: 0,
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as CryptoKey,
    });

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer hybrid-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tenantId).toBe('cognito-tenant');
    expect(body.roles).toEqual(['cognito-role']);
  });

  it('cognito:groups が空配列の場合 Auth0 ロールにフォールバックすべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: {
        sub: 'fallback-user',
        'https://tenkacloud.com/tenant_id': 'auth0-tenant',
        'cognito:groups': [],
        'https://tenkacloud.com/roles': ['auth0-role'],
        iss: '',
        aud: '',
        iat: 0,
        exp: 0,
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as CryptoKey,
    });

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer fallback-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.roles).toEqual(['auth0-role']);
  });
});
