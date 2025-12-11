import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as jose from 'jose';

vi.mock('jose');

describe('Auth Middleware', () => {
  let app: Hono;
  let authMiddleware: typeof import('./auth').authMiddleware;
  let requireRoles: typeof import('./auth').requireRoles;
  let UserRole: typeof import('./auth').UserRole;

  beforeEach(async () => {
    vi.resetModules();

    const authModule = await import('./auth');
    authMiddleware = authModule.authMiddleware;
    requireRoles = authModule.requireRoles;
    UserRole = authModule.UserRole;

    app = new Hono();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('authMiddleware', () => {
    it('認証ヘッダーがない場合、401を返すべき', async () => {
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Missing Authorization header');
    });

    it('無効な認証フォーマットの場合、401を返すべき', async () => {
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Basic token123' },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid Authorization format');
    });

    it('トークンがない場合、401を返すべき', async () => {
      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer ' },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid Authorization format');
    });

    it('JWT検証失敗の場合、401を返すべき', async () => {
      vi.mocked(jose.jwtVerify).mockRejectedValue(new Error('Invalid token'));

      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid token');
    });

    it('必須クレームがない場合、401を返すべき', async () => {
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: { sub: 'user-1' },
        protectedHeader: { alg: 'RS256' },
        key: {} as unknown,
      } as jose.JWTVerifyResult & jose.ResolvedKey);

      app.use('/*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('Invalid token claims');
    });

    it('有効なトークンの場合、リクエストを通すべき', async () => {
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-1',
          email: 'user@example.com',
          preferred_username: 'testuser',
          tenant_id: 'tenant-1',
          realm_access: { roles: ['user'] },
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as unknown,
      } as jose.JWTVerifyResult & jose.ResolvedKey);

      app.use('/*', authMiddleware);
      app.get('/test', (c) => {
        const user = c.get('user');
        return c.json({ ok: true, userId: user.id });
      });

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('user-1');
    });

    it('realm_accessがない場合でも、空のロールで通すべき', async () => {
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-1',
          email: 'user@example.com',
          preferred_username: 'testuser',
          // realm_access を省略
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as unknown,
      } as jose.JWTVerifyResult & jose.ResolvedKey);

      app.use('/*', authMiddleware);
      app.get('/test', (c) => {
        const user = c.get('user');
        return c.json({ ok: true, userId: user.id, roles: user.roles });
      });

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('user-1');
      expect(body.roles).toEqual([]);
    });
  });

  describe('requireRoles', () => {
    it('ユーザーコンテキストがない場合、401を返すべき', async () => {
      app.use('/*', requireRoles(UserRole.PLATFORM_ADMIN));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('No user context');
    });

    it('必要なロールがない場合、403を返すべき', async () => {
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-1',
          email: 'user@example.com',
          preferred_username: 'testuser',
          realm_access: { roles: ['user'] },
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as unknown,
      } as jose.JWTVerifyResult & jose.ResolvedKey);

      app.use('/*', authMiddleware);
      app.use('/*', requireRoles(UserRole.PLATFORM_ADMIN));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Insufficient permissions');
    });

    it('必要なロールがある場合、リクエストを通すべき', async () => {
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-1',
          email: 'user@example.com',
          preferred_username: 'testuser',
          realm_access: { roles: ['platform-admin'] },
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as unknown,
      } as jose.JWTVerifyResult & jose.ResolvedKey);

      app.use('/*', authMiddleware);
      app.use('/*', requireRoles(UserRole.PLATFORM_ADMIN));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(200);
    });
  });
});
