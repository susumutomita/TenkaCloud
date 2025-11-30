import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import {
  getStatusVariant,
  submitTenantUpdate,
  type TenantFormData,
} from '../tenant-utils';

// tenantApi をモック
vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    updateTenant: vi.fn(),
  },
}));

describe('tenant-utils', () => {
  describe('getStatusVariant', () => {
    it('ACTIVE ステータスは success を返すべき', () => {
      expect(getStatusVariant('ACTIVE')).toBe('success');
    });

    it('SUSPENDED ステータスは warning を返すべき', () => {
      expect(getStatusVariant('SUSPENDED')).toBe('warning');
    });

    it('その他のステータスは error を返すべき', () => {
      expect(getStatusVariant('INACTIVE')).toBe('error');
      expect(getStatusVariant('DELETED')).toBe('error');
      expect(getStatusVariant('')).toBe('error');
    });
  });

  describe('submitTenantUpdate', () => {
    const mockFormData: TenantFormData = {
      name: 'Test Tenant',
      adminEmail: 'test@example.com',
      tier: 'PRO',
      status: 'ACTIVE',
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('id が null の場合、false を返して早期リターンすべき', async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();

      const result = await submitTenantUpdate(
        null,
        mockFormData,
        onSuccess,
        onError
      );

      expect(result).toBe(false);
      expect(tenantApi.updateTenant).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('id が有効な場合、テナントを更新して true を返すべき', async () => {
      vi.mocked(tenantApi.updateTenant).mockResolvedValue({
        id: 'test-id',
        name: 'Test Tenant',
        adminEmail: 'test@example.com',
        tier: 'PRO',
        status: 'ACTIVE',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const onSuccess = vi.fn();
      const onError = vi.fn();

      const result = await submitTenantUpdate(
        'test-id',
        mockFormData,
        onSuccess,
        onError
      );

      expect(result).toBe(true);
      expect(tenantApi.updateTenant).toHaveBeenCalledWith(
        'test-id',
        mockFormData
      );
      expect(onSuccess).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('更新失敗時は onError を呼んで false を返すべき', async () => {
      vi.mocked(tenantApi.updateTenant).mockRejectedValue(
        new Error('Update failed')
      );

      const onSuccess = vi.fn();
      const onError = vi.fn();

      const result = await submitTenantUpdate(
        'test-id',
        mockFormData,
        onSuccess,
        onError
      );

      expect(result).toBe(false);
      expect(tenantApi.updateTenant).toHaveBeenCalledWith(
        'test-id',
        mockFormData
      );
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
    });
  });
});
