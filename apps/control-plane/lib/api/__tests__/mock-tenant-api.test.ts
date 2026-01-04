import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTenantApi } from '../mock-tenant-api';

// setTimeout をモック化して delay を高速化
vi.useFakeTimers();

describe('mockTenantApi', () => {
  beforeEach(() => {
    vi.clearAllTimers();
  });

  describe('listTenants', () => {
    it('テナント一覧を返すべき', async () => {
      const promise = mockTenantApi.listTenants();
      await vi.advanceTimersByTimeAsync(500);
      const tenants = await promise;

      expect(tenants).toHaveLength(3);
      expect(tenants[0].name).toBe('Acme Corp');
    });

    it('コピーを返すべき（元の配列を変更しない）', async () => {
      const promise = mockTenantApi.listTenants();
      await vi.advanceTimersByTimeAsync(500);
      const tenants = await promise;

      // 返された配列を変更しても元データには影響しない
      tenants.pop();
      expect(tenants).toHaveLength(2);
    });
  });

  describe('getTenant', () => {
    it('存在する ID でテナントを返すべき', async () => {
      const promise = mockTenantApi.getTenant('1');
      await vi.advanceTimersByTimeAsync(300);
      const tenant = await promise;

      expect(tenant).not.toBeNull();
      expect(tenant?.id).toBe('1');
      expect(tenant?.name).toBe('Acme Corp');
    });

    it('存在しない ID で null を返すべき', async () => {
      const promise = mockTenantApi.getTenant('nonexistent');
      await vi.advanceTimersByTimeAsync(300);
      const tenant = await promise;

      expect(tenant).toBeNull();
    });
  });

  describe('createTenant', () => {
    it('新しいテナントを作成して返すべき', async () => {
      const input = {
        name: 'New Tenant',
        slug: 'new-tenant',
        adminEmail: 'admin@new.com',
        tier: 'FREE' as const,
      };

      const promise = mockTenantApi.createTenant(input);
      await vi.advanceTimersByTimeAsync(800);
      const tenant = await promise;

      expect(tenant.name).toBe('New Tenant');
      expect(tenant.adminEmail).toBe('admin@new.com');
      expect(tenant.tier).toBe('FREE');
      expect(tenant.status).toBe('ACTIVE');
      expect(tenant.id).toBeDefined();
      expect(tenant.createdAt).toBeDefined();
      expect(tenant.updatedAt).toBeDefined();
    });
  });

  describe('updateTenant', () => {
    it('存在するテナントを更新して返すべき', async () => {
      const input = { name: 'Updated Name' };

      const promise = mockTenantApi.updateTenant('1', input);
      await vi.advanceTimersByTimeAsync(500);
      const tenant = await promise;

      expect(tenant).not.toBeNull();
      expect(tenant?.name).toBe('Updated Name');
      expect(tenant?.updatedAt).toBeDefined();
    });

    it('存在しない ID で null を返すべき', async () => {
      const input = { name: 'Updated Name' };

      const promise = mockTenantApi.updateTenant('nonexistent', input);
      await vi.advanceTimersByTimeAsync(500);
      const tenant = await promise;

      expect(tenant).toBeNull();
    });
  });

  describe('deleteTenant', () => {
    it('存在するテナントを削除して true を返すべき', async () => {
      // まず新しいテナントを作成
      const createPromise = mockTenantApi.createTenant({
        name: 'To Delete',
        slug: 'to-delete',
        adminEmail: 'delete@test.com',
        tier: 'FREE',
      });
      await vi.advanceTimersByTimeAsync(800);
      const created = await createPromise;

      // 作成したテナントを削除
      const deletePromise = mockTenantApi.deleteTenant(created.id);
      await vi.advanceTimersByTimeAsync(500);
      const result = await deletePromise;

      expect(result).toBe(true);
    });

    it('存在しない ID で false を返すべき', async () => {
      const promise = mockTenantApi.deleteTenant('nonexistent');
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result).toBe(false);
    });
  });
});
