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

describe('認証ミドルウェア — AUTH_SKIP モード', () => {
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

  it('AUTH_SKIP 有効時にステータス 200 を返すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('AUTH_SKIP 有効時にデフォルトのユーザー ID を設定すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.id).toBe('dev-user');
  });

  it('AUTH_SKIP 有効時にデフォルトのメールアドレスを設定すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.email).toBe('dev@tenkacloud.local');
  });

  it('AUTH_SKIP 有効時にデフォルトのユーザー名を設定すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.username).toBe('Dev Admin');
  });

  it('AUTH_SKIP 有効時にデフォルトのロールを設定すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.roles).toEqual(['platform-admin']);
  });

  it('AUTH_SKIP 有効時にデフォルトのテナント ID を設定すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.tenantId).toBe('dev-tenant');
  });

  it('開発用ヘッダーでユーザー ID を上書きできるべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'custom-user',
        'X-TenkaCloud-Dev-Email': 'custom@example.com',
        'X-TenkaCloud-Dev-Username': 'Custom User',
        'X-TenkaCloud-Dev-Tenant-Id': 'custom-tenant',
        'X-TenkaCloud-Dev-Roles': 'tenant-admin,user',
      },
    });
    const body = await res.json();
    expect(body.id).toBe('custom-user');
  });

  it('開発用ヘッダーでメールアドレスを上書きできるべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'custom-user',
        'X-TenkaCloud-Dev-Email': 'custom@example.com',
        'X-TenkaCloud-Dev-Username': 'Custom User',
        'X-TenkaCloud-Dev-Tenant-Id': 'custom-tenant',
        'X-TenkaCloud-Dev-Roles': 'tenant-admin,user',
      },
    });
    const body = await res.json();
    expect(body.email).toBe('custom@example.com');
  });

  it('開発用ヘッダーでユーザー名を上書きできるべき（スペースはハイフンに置換）', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'custom-user',
        'X-TenkaCloud-Dev-Email': 'custom@example.com',
        'X-TenkaCloud-Dev-Username': 'Custom User',
        'X-TenkaCloud-Dev-Tenant-Id': 'custom-tenant',
        'X-TenkaCloud-Dev-Roles': 'tenant-admin,user',
      },
    });
    const body = await res.json();
    // Spaces are replaced with hyphens by sanitizeDevHeader
    expect(body.username).toBe('Custom-User');
  });

  it('開発用ヘッダーでテナント ID を上書きできるべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'custom-user',
        'X-TenkaCloud-Dev-Email': 'custom@example.com',
        'X-TenkaCloud-Dev-Username': 'Custom User',
        'X-TenkaCloud-Dev-Tenant-Id': 'custom-tenant',
        'X-TenkaCloud-Dev-Roles': 'tenant-admin,user',
      },
    });
    const body = await res.json();
    expect(body.tenantId).toBe('custom-tenant');
  });

  it('開発用ヘッダーでロールを上書きできるべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'custom-user',
        'X-TenkaCloud-Dev-Email': 'custom@example.com',
        'X-TenkaCloud-Dev-Username': 'Custom User',
        'X-TenkaCloud-Dev-Tenant-Id': 'custom-tenant',
        'X-TenkaCloud-Dev-Roles': 'tenant-admin,user',
      },
    });
    const body = await res.json();
    expect(body.roles).toEqual(['tenant-admin', 'user']);
  });

  it('AUTH_SKIP_ROLES 環境変数でロールを設定できるべき', async () => {
    process.env.AUTH_SKIP = '1';
    process.env.AUTH_SKIP_ROLES = 'tenant-admin,user';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.roles).toEqual(['tenant-admin', 'user']);
  });

  it('開発用ヘッダーの値をサニタイズすべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': 'user<script>alert(1)</script>',
        'X-TenkaCloud-Dev-Tenant-Id': 'tenant; DROP TABLE users',
      },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    // Dangerous characters should be replaced with hyphens
    expect(body.id).not.toContain('<');
    expect(body.id).not.toContain('>');
    expect(body.tenantId).not.toContain(';');
  });

  it('空の開発用ヘッダーはフォールバック値を使用すべき', async () => {
    process.env.AUTH_SKIP = '1';

    const { authMiddleware } = await import('./auth');

    const app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json(c.get('user')));

    const res = await app.request('/test', {
      headers: {
        'X-TenkaCloud-Dev-User-Id': '   ',
        'X-TenkaCloud-Dev-Tenant-Id': '',
      },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('dev-user');
    expect(body.tenantId).toBe('dev-tenant');
  });
});
