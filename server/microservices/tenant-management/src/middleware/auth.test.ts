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

describe('認証ミドルウェア — JWT 検証・JWKS 設定・エラーケース', () => {
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

  // ─── JWT 検証（Auth0 クレーム） ──────────────────────
  describe('JWT 検証（Auth0 クレーム）', () => {
    it('Auth0 トークンからユーザー情報を抽出すべき', async () => {
      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'auth0|user-123',
          email: 'user@example.com',
          name: 'Test User',
          org_id: 'org-abc',
          'https://tenkacloud.com/roles': ['tenant-admin'],
          'https://tenkacloud.com/tenant_id': 'tenant-xyz',
          iss: 'https://dev-tenkacloud.auth0.com/',
          aud: 'https://api.tenkacloud.com',
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
        headers: { Authorization: 'Bearer valid-auth0-token' },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe('auth0|user-123');
      expect(body.email).toBe('user@example.com');
      expect(body.username).toBe('Test User');
      expect(body.roles).toEqual(['tenant-admin']);
      expect(body.tenantId).toBe('tenant-xyz');
      expect(body.organizationId).toBe('org-abc');
    });

    it('email がないトークンでも空文字として処理すべき', async () => {
      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'auth0|m2m-client',
          nickname: 'api-client',
          'https://tenkacloud.com/roles': [],
          'https://tenkacloud.com/tenant_id': 'tenant-m2m',
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
        headers: { Authorization: 'Bearer m2m-token' },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.email).toBe('');
      expect(body.username).toBe('api-client');
    });

    it('Auth0 namespace にロールがない場合は空配列を返すべき', async () => {
      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'auth0|user-no-roles',
          email: 'noroles@example.com',
          'https://tenkacloud.com/tenant_id': 'tenant-abc',
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
        headers: { Authorization: 'Bearer token-no-roles' },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.roles).toEqual([]);
    });
  });

  // ─── JWKS_URI / JWT_ISSUER 環境変数 ───────────────────
  describe('JWKS_URI / JWT_ISSUER 設定', () => {
    it('JWKS_URI 環境変数が設定されている場合はそれを使用すべき', async () => {
      process.env.JWKS_URI =
        'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id/.well-known/jwks.json';
      process.env.JWT_ISSUER =
        'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id';

      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'cognito-user',
          'custom:tenant_id': 'tenant-via-env',
          'cognito:groups': ['user'],
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
        headers: { Authorization: 'Bearer token' },
      });
      expect(res.status).toBe(200);

      // createRemoteJWKSet should have been called with the custom JWKS_URI
      expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(
        new URL(
          'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id/.well-known/jwks.json',
        ),
      );

      // jwtVerify should have been called with the custom issuer
      expect(jose.jwtVerify).toHaveBeenCalledWith(
        'token',
        expect.any(Function),
        expect.objectContaining({
          issuer:
            'https://cognito-idp.ap-northeast-1.amazonaws.com/pool-id',
        }),
      );
    });

    it('JWT_AUDIENCE が設定されている場合は audience を検証すべき', async () => {
      process.env.JWT_AUDIENCE = 'my-custom-api';

      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-aud',
          'https://tenkacloud.com/tenant_id': 'tenant-aud',
          'https://tenkacloud.com/roles': ['user'],
          iss: '',
          aud: 'my-custom-api',
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
        headers: { Authorization: 'Bearer aud-token' },
      });
      expect(res.status).toBe(200);

      expect(jose.jwtVerify).toHaveBeenCalledWith(
        'aud-token',
        expect.any(Function),
        expect.objectContaining({ audience: 'my-custom-api' }),
      );
    });
  });

  // ─── 認証エラーケース ─────────────────────────────────
  describe('認証エラーケース', () => {
    it('Authorization ヘッダーがない場合は 401 を返すべき', async () => {
      const { authMiddleware } = await import('./auth');

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe('Unauthorized: Missing Authorization header');
    });

    it('Bearer プレフィックスがない場合は 401 を返すべき', async () => {
      const { authMiddleware } = await import('./auth');

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Basic invalid-format' },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe('Unauthorized: Invalid Authorization format');
    });

    it('JWT 検証失敗時に 401 を返すべき', async () => {
      const jose = await import('jose');
      vi.mocked(jose.jwtVerify).mockRejectedValue(
        new Error('Invalid signature'),
      );

      const { authMiddleware } = await import('./auth');

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer bad-token' },
      });
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe('Unauthorized: Invalid token');
    });
  });
});
