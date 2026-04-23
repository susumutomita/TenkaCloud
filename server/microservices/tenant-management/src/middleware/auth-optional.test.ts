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

describe('認証ミドルウェア — optionalAuth', () => {
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

  it('トークンがない場合はユーザーコンテキストなしで通過すべき', async () => {
    const { optionalAuth } = await import('./auth');

    const app = new Hono();
    app.use('/*', optionalAuth);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasUser).toBe(false);
  });

  it('不正なフォーマットの場合はユーザーコンテキストなしで通過すべき', async () => {
    const { optionalAuth } = await import('./auth');

    const app = new Hono();
    app.use('/*', optionalAuth);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request('/test', {
      headers: { Authorization: 'Basic something' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasUser).toBe(false);
  });

  it('有効なトークンがある場合はユーザーコンテキストを設定すべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: {
        sub: 'optional-user',
        email: 'optional@example.com',
        name: 'Optional User',
        'custom:tenant_id': 'optional-tenant',
        'cognito:groups': ['user'],
        iss: '',
        aud: '',
        iat: 0,
        exp: 0,
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as CryptoKey,
    });

    const { optionalAuth } = await import('./auth');

    const app = new Hono();
    app.use('/*', optionalAuth);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-optional-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('optional-user');
    expect(body.tenantId).toBe('optional-tenant');
    expect(body.roles).toEqual(['user']);
  });

  it('無効なトークンの場合はユーザーコンテキストなしで通過すべき', async () => {
    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockRejectedValue(
      new Error('Invalid token'),
    );

    const { optionalAuth } = await import('./auth');

    const app = new Hono();
    app.use('/*', optionalAuth);
    app.get('/test', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasUser).toBe(false);
  });
});
