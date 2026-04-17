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

describe('認証ミドルウェア — requireRoles / requireTenantAccess', () => {
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

  // ─── requireRoles ────────────────────────────────────
  describe('requireRoles ミドルウェア', () => {
    it('必要なロールを持つユーザーにアクセスを許可すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const { authMiddleware, requireRoles, UserRole } = await import(
        './auth'
      );

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get(
        '/admin',
        requireRoles(UserRole.PLATFORM_ADMIN),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/admin');
      expect(res.status).toBe(200);
    });

    it('必要なロールを持たないユーザーに 403 を返すべき', async () => {
      process.env.AUTH_SKIP = '1';
      process.env.AUTH_SKIP_ROLES = 'user';

      const { authMiddleware, requireRoles, UserRole } = await import(
        './auth'
      );

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get(
        '/admin',
        requireRoles(UserRole.PLATFORM_ADMIN),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/admin');
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toBe('Forbidden: Insufficient permissions');
    });

    it('ユーザーコンテキストがない場合は 401 を返すべき', async () => {
      const { requireRoles, UserRole } = await import('./auth');

      const app = new Hono();
      // authMiddleware を適用せずに requireRoles のみ
      app.get(
        '/admin',
        requireRoles(UserRole.PLATFORM_ADMIN),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/admin');
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.error).toBe('Unauthorized: No user context');
    });
  });

  // ─── requireTenantAccess ────────────────────────────
  describe('requireTenantAccess ミドルウェア', () => {
    it('プラットフォーム管理者はすべてのテナントにアクセスできるべき', async () => {
      process.env.AUTH_SKIP = '1';

      const { authMiddleware, requireTenantAccess } = await import(
        './auth'
      );

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get(
        '/tenants/:tenantId',
        requireTenantAccess(),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/tenants/any-tenant-id');
      expect(res.status).toBe(200);
    });

    it('異なるテナントへのアクセスは 403 を返すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const { authMiddleware, requireTenantAccess } = await import(
        './auth'
      );

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get(
        '/tenants/:tenantId',
        requireTenantAccess(),
        (c) => c.json({ ok: true }),
      );

      // Dev user has tenantId = 'dev-tenant', requesting different tenant
      const res = await app.request('/tenants/other-tenant', {
        headers: {
          'X-TenkaCloud-Dev-Roles': 'tenant-admin',
          'X-TenkaCloud-Dev-Tenant-Id': 'my-tenant',
        },
      });
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.error).toBe('Forbidden: Cannot access this tenant');
    });

    it('自分のテナントへのアクセスは許可すべき', async () => {
      process.env.AUTH_SKIP = '1';

      const { authMiddleware, requireTenantAccess } = await import(
        './auth'
      );

      const app = new Hono();
      app.use('/*', authMiddleware);
      app.get(
        '/tenants/:tenantId',
        requireTenantAccess(),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/tenants/my-tenant', {
        headers: {
          'X-TenkaCloud-Dev-Roles': 'tenant-admin',
          'X-TenkaCloud-Dev-Tenant-Id': 'my-tenant',
        },
      });
      expect(res.status).toBe(200);
    });

    it('ユーザーコンテキストがない場合は 401 を返すべき', async () => {
      const { requireTenantAccess } = await import('./auth');

      const app = new Hono();
      app.get(
        '/tenants/:tenantId',
        requireTenantAccess(),
        (c) => c.json({ ok: true }),
      );

      const res = await app.request('/tenants/any-tenant');
      expect(res.status).toBe(401);
    });
  });
});
