import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from './lib/prisma';

// Mock jose library to prevent Keycloak connection attempts
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

// Mock authentication middleware for testing
vi.mock('./middleware/auth', async () => {
  const actual = await vi.importActual('./middleware/auth');
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      // Inject test user with PLATFORM_ADMIN role
      c.set('user', {
        id: 'test-user-id',
        email: 'test@example.com',
        username: 'testuser',
        roles: ['platform-admin'],
      });
      await next();
    },
    requireRoles: () => async (_c: any, next: any) => {
      // Always allow in tests
      await next();
    },
  };
});

import { app } from './index';

describe('テナント管理API', () => {
  describe('GET /health', () => {
    it('ヘルスチェックが成功するべき', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: 'ok',
        service: 'tenant-management',
      });
    });
  });

  describe('POST /api/tenants', () => {
    it('有効なデータでテナントを作成できるべき', async () => {
      const tenantData = {
        name: 'Test Organization',
        adminEmail: 'admin@test.com',
        tier: 'FREE',
        status: 'ACTIVE',
      };

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        name: tenantData.name,
        adminEmail: tenantData.adminEmail,
        tier: tenantData.tier,
        status: tenantData.status,
      });
      expect(body.id).toBeDefined();
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it('デフォルト値でテナントを作成できるべき', async () => {
      const tenantData = {
        name: 'Default Tenant',
        adminEmail: 'default@test.com',
      };

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.tier).toBe('FREE');
      expect(body.status).toBe('ACTIVE');
    });

    it('不正なメールアドレスでバリデーションエラーになるべき', async () => {
      const tenantData = {
        name: 'Invalid Email Tenant',
        adminEmail: 'not-an-email',
      };

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
      expect(body.details).toBeDefined();
    });

    it('空の名前でバリデーションエラーになるべき', async () => {
      const tenantData = {
        name: '',
        adminEmail: 'valid@test.com',
      };

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('重複したメールアドレスで409エラーになるべき', async () => {
      const tenantData = {
        name: 'Duplicate Email Tenant',
        adminEmail: 'duplicate@test.com',
      };

      // 最初のテナントを作成
      const firstRes = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });
      expect(firstRes.status).toBe(201);

      // 同じメールアドレスで再度作成を試みる
      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Tenant with this email already exists');
    });

    it('不正なtier値でバリデーションエラーになるべき', async () => {
      const tenantData = {
        name: 'Invalid Tier',
        adminEmail: 'tier@test.com',
        tier: 'INVALID_TIER',
      };

      const res = await app.request('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tenantData),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });
  });

  describe('GET /api/tenants', () => {
    beforeEach(async () => {
      // テストデータを作成
      await prisma.tenant.createMany({
        data: [
          {
            name: 'Tenant 1',
            adminEmail: 'tenant1@test.com',
            tier: 'FREE',
            status: 'ACTIVE',
          },
          {
            name: 'Tenant 2',
            adminEmail: 'tenant2@test.com',
            tier: 'PRO',
            status: 'ACTIVE',
          },
          {
            name: 'Tenant 3',
            adminEmail: 'tenant3@test.com',
            tier: 'ENTERPRISE',
            status: 'SUSPENDED',
          },
        ],
      });
    });

    it('すべてのテナントを取得できるべき', async () => {
      const res = await app.request('/api/tenants');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(3);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBe(3);
    });

    it('テナントが作成日時降順でソートされているべき', async () => {
      const res = await app.request('/api/tenants');
      const body = await res.json();

      // 作成日時が降順になっているか確認
      for (let i = 0; i < body.data.length - 1; i++) {
        const current = new Date(body.data[i].createdAt);
        const next = new Date(body.data[i + 1].createdAt);
        expect(current >= next).toBe(true);
      }
    });

    it('テナントが存在しない場合は空配列を返すべき', async () => {
      // すべてのテナントを削除
      await prisma.tenant.deleteMany();

      const res = await app.request('/api/tenants');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });
  });

  describe('GET /api/tenants/:id', () => {
    let testTenant: any;

    beforeEach(async () => {
      testTenant = await prisma.tenant.create({
        data: {
          name: 'Test Tenant',
          adminEmail: 'test@test.com',
          tier: 'PRO',
          status: 'ACTIVE',
        },
      });
    });

    it('IDでテナントを取得できるべき', async () => {
      const res = await app.request(`/api/tenants/${testTenant.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        id: testTenant.id,
        name: testTenant.name,
        adminEmail: testTenant.adminEmail,
      });
    });

    it('存在しないIDで404エラーになるべき', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const res = await app.request(`/api/tenants/${nonExistentId}`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なUUID形式で400エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid-uuid');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });
  });

  describe('PATCH /api/tenants/:id', () => {
    let testTenant: any;

    beforeEach(async () => {
      testTenant = await prisma.tenant.create({
        data: {
          name: 'Original Name',
          adminEmail: 'original@test.com',
          tier: 'FREE',
          status: 'ACTIVE',
        },
      });
    });

    it('テナント名を更新できるべき', async () => {
      const updateData = { name: 'Updated Name' };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Name');
      expect(body.adminEmail).toBe('original@test.com'); // 変更されていないはず
    });

    it('テナントのステータスを更新できるべき', async () => {
      const updateData = { status: 'SUSPENDED' };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('SUSPENDED');
    });

    it('テナントのtierを更新できるべき', async () => {
      const updateData = { tier: 'ENTERPRISE' };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tier).toBe('ENTERPRISE');
    });

    it('複数のフィールドを同時に更新できるべき', async () => {
      const updateData = {
        name: 'New Name',
        tier: 'PRO',
        status: 'ACTIVE',
      };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('New Name');
      expect(body.tier).toBe('PRO');
      expect(body.status).toBe('ACTIVE');
    });

    it('存在しないIDで404エラーになるべき', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const updateData = { name: 'Updated Name' };
      const res = await app.request(`/api/tenants/${nonExistentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なUUID形式で400エラーになるべき', async () => {
      const updateData = { name: 'Updated Name' };
      const res = await app.request('/api/tenants/invalid-uuid', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });

    it('不正なメールアドレスでバリデーションエラーになるべき', async () => {
      const updateData = { adminEmail: 'not-an-email' };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('既存のメールアドレスに更新しようとすると409エラーになるべき', async () => {
      // 別のテナントを作成
      const anotherTenant = await prisma.tenant.create({
        data: {
          name: 'Another Tenant',
          adminEmail: 'another@test.com',
          tier: 'FREE',
          status: 'ACTIVE',
        },
      });
      expect(anotherTenant).toBeDefined();
      expect(anotherTenant.adminEmail).toBe('another@test.com');

      // 既存のメールアドレスに更新を試みる
      const updateData = { adminEmail: 'another@test.com' };
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Tenant with this email already exists');
    });
  });

  describe('DELETE /api/tenants/:id', () => {
    let testTenant: any;

    beforeEach(async () => {
      testTenant = await prisma.tenant.create({
        data: {
          name: 'To Be Deleted',
          adminEmail: 'delete@test.com',
          tier: 'FREE',
          status: 'ACTIVE',
        },
      });
    });

    it('テナントを削除できるべき', async () => {
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        message: 'Tenant deleted successfully',
      });

      // 削除されたことを確認
      const deletedTenant = await prisma.tenant.findUnique({
        where: { id: testTenant.id },
      });
      expect(deletedTenant).toBeNull();
    });

    it('存在しないIDで404エラーになるべき', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';
      const res = await app.request(`/api/tenants/${nonExistentId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });

    it('不正なUUID形式で400エラーになるべき', async () => {
      const res = await app.request('/api/tenants/invalid-uuid', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid tenant ID');
    });

    it('削除後に同じIDで再度削除すると404エラーになるべき', async () => {
      // 最初の削除
      await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'DELETE',
      });

      // 2回目の削除
      const res = await app.request(`/api/tenants/${testTenant.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tenant not found');
    });
  });
});
