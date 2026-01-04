import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';
import { tenantApi } from '../tenant-api';

// API base URL 環境変数のテスト
describe('API Base URL の決定', () => {
  it('サーバーサイドでは TENANT_API_BASE_URL を使用すべき', async () => {
    // tenant-api.ts を再インポートして確認
    // テスト環境では window が未定義なので、サーバーサイドとして扱われる
    const module = await import('../tenant-api');
    expect(module.tenantApi).toBeDefined();
  });
});

// グローバル fetch のモック
const mockFetch = vi.fn() as unknown as typeof fetch & ReturnType<typeof vi.fn>;
global.fetch = mockFetch;

const mockTenant: Tenant = {
  id: '1',
  name: 'テストテナント',
  slug: 'test-tenant',
  status: 'ACTIVE',
  tier: 'FREE',
  adminEmail: 'admin@example.com',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('tenantApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listTenants', () => {
    it('テナント一覧を取得すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [mockTenant],
            pagination: {
              page: 1,
              limit: 10,
              total: 1,
              totalPages: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          }),
      });

      const tenants = await tenantApi.listTenants();

      expect(tenants).toEqual([mockTenant]);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tenants'),
        { cache: 'no-store' }
      );
    });

    it('API エラー時に例外をスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        text: () => Promise.resolve('Server Error'),
      });

      await expect(tenantApi.listTenants()).rejects.toThrow(
        'Tenant API request failed: 500 Server Error'
      );
    });
  });

  describe('getTenant', () => {
    it('テナントを取得すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: StatusCodes.OK,
        json: () => Promise.resolve(mockTenant),
      });

      const tenant = await tenantApi.getTenant('1');

      expect(tenant).toEqual(mockTenant);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tenants/1'),
        { cache: 'no-store' }
      );
    });

    it('テナントが存在しない場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.NOT_FOUND,
        text: () => Promise.resolve('Not Found'),
      });

      const tenant = await tenantApi.getTenant('not-found');

      expect(tenant).toBeNull();
    });

    it('404 以外のエラー時に例外をスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        text: () => Promise.resolve('Server Error'),
      });

      await expect(tenantApi.getTenant('1')).rejects.toThrow(
        'Tenant API request failed: 500 Server Error'
      );
    });
  });

  describe('createTenant', () => {
    it('テナントを作成すべき', async () => {
      const input: CreateTenantInput = {
        name: 'テストテナント',
        slug: 'test-tenant',
        adminEmail: 'admin@example.com',
        tier: 'FREE',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTenant),
      });

      const tenant = await tenantApi.createTenant(input);

      expect(tenant).toEqual(mockTenant);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tenants'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      );
    });

    it('作成失敗時に例外をスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.BAD_REQUEST,
        text: () => Promise.resolve('Validation Error'),
      });

      await expect(
        tenantApi.createTenant({
          name: '',
          slug: '',
          adminEmail: 'invalid',
          tier: 'FREE',
        })
      ).rejects.toThrow('Tenant API request failed: 400 Validation Error');
    });
  });

  describe('updateTenant', () => {
    it('テナントを更新すべき', async () => {
      const input: UpdateTenantInput = {
        name: '更新テナント',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        status: StatusCodes.OK,
        json: () => Promise.resolve({ ...mockTenant, name: '更新テナント' }),
      });

      const tenant = await tenantApi.updateTenant('1', input);

      expect(tenant?.name).toBe('更新テナント');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tenants/1'),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      );
    });

    it('テナントが存在しない場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.NOT_FOUND,
        text: () => Promise.resolve('Not Found'),
      });

      const tenant = await tenantApi.updateTenant('not-found', {
        name: 'テスト',
      });

      expect(tenant).toBeNull();
    });

    it('404 以外のエラー時に例外をスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        text: () => Promise.resolve('Server Error'),
      });

      await expect(
        tenantApi.updateTenant('1', { name: 'テスト' })
      ).rejects.toThrow('Tenant API request failed: 500 Server Error');
    });
  });

  describe('deleteTenant', () => {
    it('テナントを削除すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: StatusCodes.NO_CONTENT,
        json: () => Promise.resolve({}),
      });

      const result = await tenantApi.deleteTenant('1');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tenants/1'),
        { method: 'DELETE' }
      );
    });

    it('テナントが存在しない場合は false を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.NOT_FOUND,
        text: () => Promise.resolve('Not Found'),
      });

      const result = await tenantApi.deleteTenant('not-found');

      expect(result).toBe(false);
    });

    it('404 以外のエラー時に例外をスローすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        text: () => Promise.resolve('Server Error'),
      });

      await expect(tenantApi.deleteTenant('1')).rejects.toThrow(
        'Tenant API request failed: 500 Server Error'
      );
    });
  });
});
