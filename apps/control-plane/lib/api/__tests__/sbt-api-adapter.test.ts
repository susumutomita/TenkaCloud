import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSbtTenantApi } from '../sbt-api-adapter';
import { TenantApiError } from '../tenant-api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SBT API Adapter', () => {
  const api = createSbtTenantApi(
    'https://api.example.com',
    async () => 'test-token',
  );

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('listTenants', () => {
    it('GET /tenant-registrations を呼んで Tenant 配列を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              tenantId: 't-1',
              tenantRegistrationId: 'reg-1',
              tenantName: 'Test Corp',
              email: 'admin@test.com',
              tier: 'basic',
              tenantStatus: 'created',
            },
          ],
        }),
      });

      const tenants = await api.listTenants();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenant-registrations',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
      expect(tenants).toHaveLength(1);
      expect(tenants[0].id).toBe('t-1');
      expect(tenants[0].provisioningStatus).toBe('COMPLETED');
    });
  });

  describe('getTenant', () => {
    it('テナントを返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tenantId: 't-1',
          tenantName: 'Test Corp',
          email: 'admin@test.com',
          tier: 'basic',
          tenantStatus: 'created',
        }),
      });

      const tenant = await api.getTenant('t-1');
      expect(tenant?.id).toBe('t-1');
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"message":"Not found"}',
      });

      const tenant = await api.getTenant('nonexistent');
      expect(tenant).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"message":"Server error"}',
      });

      await expect(api.getTenant('t-1')).rejects.toThrow(TenantApiError);
    });
  });

  describe('createTenant', () => {
    it('SBT フォーマットで POST を呼ぶべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            tenantId: 't-new',
            tenantName: 'New Corp',
            email: 'new@test.com',
            tier: 'pro',
            tenantStatus: 'In progress',
          },
        }),
      });

      const tenant = await api.createTenant({
        name: 'New Corp',
        slug: 'new-corp',
        adminEmail: 'new@test.com',
        tier: 'PRO',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tenantData.tenantName).toBe('New Corp');
      expect(body.tenantData.tier).toBe('pro');
      expect(tenant.id).toBe('t-new');
    });
  });

  describe('updateTenant', () => {
    it('PUT /tenants/{id} を呼ぶべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tenantId: 't-1',
          tenantName: 'Updated',
          email: 'a@b.com',
          tier: 'pro',
          tenantStatus: 'created',
        }),
      });

      const tenant = await api.updateTenant('t-1', { name: 'Updated' });
      expect(tenant?.name).toBe('Updated');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants/t-1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"message":"Not found"}',
      });

      const result = await api.updateTenant('x', { name: 'X' });
      expect(result).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"message":"Server error"}',
      });

      await expect(api.updateTenant('t-1', { name: 'X' })).rejects.toThrow(
        TenantApiError,
      );
    });
  });

  describe('deleteTenant', () => {
    it('成功時は true を返すべき', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await api.deleteTenant('reg-1')).toBe(true);
    });

    it('404 の場合は false を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"message":"Not found"}',
      });
      expect(await api.deleteTenant('x')).toBe(false);
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"message":"Server error"}',
      });

      await expect(api.deleteTenant('x')).rejects.toThrow(TenantApiError);
    });
  });

  describe('getProvisioningStatus', () => {
    it('プロビジョニング状態を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tenantStatus: 'created',
        }),
      });

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('COMPLETED');
      expect(status?.provisioningEnabled).toBe(true);
    });

    it('tenantStatus が created でない場合は IN_PROGRESS を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tenantStatus: 'pending',
        }),
      });

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('IN_PROGRESS');
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"message":"Not found"}',
      });
      expect(await api.getProvisioningStatus('x')).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"message":"Server error"}',
      });

      await expect(api.getProvisioningStatus('t-1')).rejects.toThrow(
        TenantApiError,
      );
    });
  });

  describe('triggerProvisioning', () => {
    it('SBT では no-op を返すべき', async () => {
      const result = await api.triggerProvisioning('t-1');
      expect(result.success).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('sbtFetch エラーハンドリング', () => {
    it('API エラー時に TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"message":"Internal error"}',
      });

      await expect(api.listTenants()).rejects.toThrow(TenantApiError);
    });

    it('JSON に message/error がない場合はデフォルトメッセージを使うべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => '{"foo":"bar"}',
      });

      await expect(api.listTenants()).rejects.toThrow('SBT API request failed');
    });

    it('トークンが null の場合は Authorization ヘッダーなしで呼ぶべき', async () => {
      const noAuthApi = createSbtTenantApi(
        'https://api.example.com',
        async () => null,
      );
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await noAuthApi.listTenants();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it('JSON パースに失敗した場合はデフォルトメッセージを使うべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'not json',
      });

      await expect(api.listTenants()).rejects.toThrow('SBT API request failed');
    });

    it('エラーレスポンスの error フィールドを使うべき', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"Bad request"}',
      });

      await expect(api.listTenants()).rejects.toThrow('Bad request');
    });
  });

  describe('toTenant マッピング', () => {
    it('registrationStatus が In progress の場合は IN_PROGRESS にマッピングすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              tenantId: 't-1',
              tenantName: 'Corp',
              email: 'a@b.com',
              tier: 'basic',
              tenantStatus: 'pending',
              registrationStatus: 'In progress',
            },
          ],
        }),
      });

      const tenants = await api.listTenants();
      expect(tenants[0].provisioningStatus).toBe('IN_PROGRESS');
    });

    it('tier が未知の場合は FREE にフォールバックすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              tenantId: 't-1',
              tenantName: 'Corp',
              email: 'a@b.com',
              tier: 'UNKNOWN_TIER',
              tenantStatus: 'created',
            },
          ],
        }),
      });

      const tenants = await api.listTenants();
      expect(tenants[0].tier).toBe('FREE');
    });

    it('SBT レスポンスの createdAt/updatedAt を使用すべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              tenantId: 't-1',
              tenantName: 'Corp',
              email: 'a@b.com',
              tier: 'pro',
              tenantStatus: 'created',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-06-01T00:00:00Z',
            },
          ],
        }),
      });

      const tenants = await api.listTenants();
      expect(tenants[0].createdAt).toBe('2024-01-01T00:00:00Z');
      expect(tenants[0].updatedAt).toBe('2024-06-01T00:00:00Z');
    });

    it('createdAt/updatedAt が未提供の場合は空文字にフォールバックすべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              tenantId: 't-1',
              tenantName: 'Corp',
              email: 'a@b.com',
              tier: 'pro',
              tenantStatus: 'created',
            },
          ],
        }),
      });

      const tenants = await api.listTenants();
      expect(tenants[0].createdAt).toBe('');
      expect(tenants[0].updatedAt).toBe('');
    });
  });

  describe('Zod バリデーション', () => {
    it('listTenants で不正なレスポンスの場合 TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'response' }),
      });

      await expect(api.listTenants()).rejects.toThrow(TenantApiError);
    });

    it('getTenant で不正なレスポンスの場合 TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'response' }),
      });

      await expect(api.getTenant('t-1')).rejects.toThrow(TenantApiError);
    });

    it('createTenant で不正なレスポンスの場合 TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { invalid: 'response' } }),
      });

      await expect(
        api.createTenant({
          name: 'Corp',
          slug: 'corp',
          adminEmail: 'a@b.com',
          tier: 'FREE',
        }),
      ).rejects.toThrow(TenantApiError);
    });

    it('updateTenant で不正なレスポンスの場合 TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'response' }),
      });

      await expect(api.updateTenant('t-1', { name: 'X' })).rejects.toThrow(
        TenantApiError,
      );
    });

    it('getProvisioningStatus で不正なレスポンスの場合 TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ invalid: 'response' }),
      });

      await expect(api.getProvisioningStatus('t-1')).rejects.toThrow(
        TenantApiError,
      );
    });
  });
});
