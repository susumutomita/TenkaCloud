import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import {
  tenantIsolationMiddleware,
  validateTenantParamMiddleware,
} from './tenant-isolation';
import type { TenantContext } from '../tenant-context';

function createAppWithAuth(auth?: { tenantId?: string; userId?: string }) {
  const app = new Hono();

  // 認証コンテキストを設定するミドルウェア
  if (auth !== undefined) {
    app.use('/*', async (c, next) => {
      c.set('auth' as never, auth as never);
      await next();
    });
  }

  app.use('/*', tenantIsolationMiddleware);

  app.get('/test', (c) => {
    const ctx = c.get('tenantContext') as TenantContext;
    return c.json({ tenantId: ctx.tenantId });
  });

  return app;
}

function createAppWithTenantParam() {
  const app = new Hono();

  app.use('/*', async (c, next) => {
    c.set('auth' as never, { tenantId: 'tenant-123', userId: 'user-1' } as never);
    await next();
  });

  app.use('/*', tenantIsolationMiddleware);
  app.use('/tenants/:tenantId/*', validateTenantParamMiddleware);

  app.get('/tenants/:tenantId/resources', (c) => {
    return c.json({ ok: true });
  });

  return app;
}

describe('tenantIsolationMiddleware', () => {
  it('有効な認証コンテキストからテナントコンテキストを設定すべき', async () => {
    const app = createAppWithAuth({
      tenantId: 'tenant-123',
      userId: 'user-1',
    });

    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { tenantId: string };
    expect(body.tenantId).toBe('tenant-123');
  });

  it('認証コンテキストがない場合 UNAUTHORIZED を返すべき', async () => {
    const app = new Hono();
    app.use('/*', tenantIsolationMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('認証コンテキストがありません');
  });

  it('テナント ID がない場合 FORBIDDEN を返すべき', async () => {
    const app = createAppWithAuth({ userId: 'user-1' });

    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('テナント情報がありません');
  });

  it('テナント ID が空文字列の場合 FORBIDDEN を返すべき', async () => {
    const app = createAppWithAuth({ tenantId: '', userId: 'user-1' });

    const res = await app.request('/test');
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('テナント情報がありません');
  });
});

describe('validateTenantParamMiddleware', () => {
  it('URL パラメータのテナント ID がコンテキストと一致する場合リクエストを許可すべき', async () => {
    const app = createAppWithTenantParam();

    const res = await app.request('/tenants/tenant-123/resources');
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('URL パラメータのテナント ID がコンテキストと一致しない場合 FORBIDDEN を返すべき', async () => {
    const app = createAppWithTenantParam();

    const res = await app.request('/tenants/tenant-other/resources');
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('別テナントのリソースにはアクセスできません');
  });

  it('テナントコンテキストがない場合 INTERNAL_SERVER_ERROR を返すべき', async () => {
    const app = new Hono();
    // tenantIsolationMiddleware をスキップして直接 validateTenantParamMiddleware を使用
    app.use('/tenants/:tenantId/*', validateTenantParamMiddleware);
    app.get('/tenants/:tenantId/resources', (c) => c.json({ ok: true }));

    const res = await app.request('/tenants/tenant-123/resources');
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('テナントコンテキストがありません');
  });
});
