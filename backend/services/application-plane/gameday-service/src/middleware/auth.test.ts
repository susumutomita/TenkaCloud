import { describe, it, expect } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { Hono } from 'hono';
import { requireAdmin } from './auth';
import type { AuthContext } from './auth';

function createApp(roles: string[]) {
  const app = new Hono();
  // authMiddleware の代わりに手動で auth をセット
  app.use('/*', async (c, next) => {
    c.set('auth', {
      userId: 'user-1',
      tenantId: 'tenant-1',
      roles,
    } satisfies AuthContext);
    await next();
  });
  app.use('/*', requireAdmin);
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('requireAdmin ミドルウェア', () => {
  it('admin ロールを持つユーザーを許可すべき', async () => {
    const app = createApp(['admin']);
    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.OK);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('admin ロールを持たないユーザーに 403 を返すべき', async () => {
    const app = createApp(['user']);
    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = await res.json();
    expect(body.error).toBe('管理者権限が必要です');
  });

  it('ロールが空のユーザーに 403 を返すべき', async () => {
    const app = createApp([]);
    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = await res.json();
    expect(body.error).toBe('管理者権限が必要です');
  });
});
