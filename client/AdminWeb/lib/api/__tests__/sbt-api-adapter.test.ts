import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSbtTenantApi } from '../sbt-api-adapter';
import { TenantApiError } from '../tenant-api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okJson(json: unknown) {
  return { ok: true, json: async () => json };
}

function errJson(status: number, body: string) {
  return { ok: false, status, text: async () => body };
}

describe('SBT API Adapter (v0.3.9 wire format)', () => {
  const api = createSbtTenantApi(
    'https://api.example.com',
    async () => 'test-token',
  );

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('listTenants', () => {
    it('GET /tenants を Bearer 付きで叩いて UI の Tenant 配列に変換すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          data: [
            {
              tenantId: 't-1',
              tenantName: 'Test Corp',
              email: 'admin@test.com',
              tier: 'basic',
              tenantStatus: 'Complete',
            },
          ],
        }),
      );

      const tenants = await api.listTenants();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
      expect(tenants).toHaveLength(1);
      expect(tenants[0].id).toBe('t-1');
      expect(tenants[0].provisioningStatus).toBe('COMPLETED');
      expect(tenants[0].tier).toBe('FREE');
    });

    it('レスポンスが配列直返しでも受け付けるべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'A',
            email: 'a@b.com',
            tier: 'basic',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants).toHaveLength(1);
    });

    it('不正レスポンスは TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue(okJson({ invalid: 'response' }));
      await expect(api.listTenants()).rejects.toThrow(TenantApiError);
    });
  });

  describe('getTenant', () => {
    it('data ラップ無しの単体レスポンスでも Tenant を返すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Test Corp',
          email: 'admin@test.com',
          tier: 'standard',
          tenantStatus: 'Complete',
        }),
      );

      const tenant = await api.getTenant('t-1');
      expect(tenant?.id).toBe('t-1');
      expect(tenant?.tier).toBe('PRO');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants/t-1',
        expect.any(Object),
      );
    });

    it('id を URL エンコードすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't with space',
          tenantName: 'X',
          email: 'a@b.com',
          tier: 'basic',
          tenantStatus: 'Complete',
        }),
      );

      await api.getTenant('t with space');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants/t%20with%20space',
        expect.any(Object),
      );
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue(errJson(404, '{"message":"Not found"}'));
      expect(await api.getTenant('nonexistent')).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"message":"Server error"}'));
      await expect(api.getTenant('t-1')).rejects.toThrow(TenantApiError);
    });

    it('不正レスポンスは TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue(okJson({ invalid: 'response' }));
      await expect(api.getTenant('t-1')).rejects.toThrow(TenantApiError);
    });
  });

  describe('createTenant', () => {
    it('POST /tenants にフラット payload を投げるべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          data: {
            tenantId: 't-new',
            tenantName: 'New Corp',
            email: 'new@test.com',
            tier: 'standard',
            tenantStatus: 'In progress',
          },
        }),
      );

      const tenant = await api.createTenant({
        name: 'New Corp',
        slug: 'new-corp',
        adminEmail: 'new@test.com',
        tier: 'PRO',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        tenantName: 'New Corp',
        email: 'new@test.com',
        tier: 'standard',
        tenantStatus: 'In progress',
      });
      expect(tenant.id).toBe('t-new');
      expect(tenant.provisioningStatus).toBe('IN_PROGRESS');
    });

    it('ENTERPRISE は SBT の premium にマッピングすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          data: {
            tenantId: 't-1',
            tenantName: 'X',
            email: 'a@b.com',
            tier: 'premium',
            tenantStatus: 'In progress',
          },
        }),
      );

      await api.createTenant({
        name: 'X',
        slug: 'x',
        adminEmail: 'a@b.com',
        tier: 'ENTERPRISE',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tier).toBe('premium');
    });

    it('不正レスポンスは TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue(okJson({ data: { invalid: 'response' } }));
      await expect(
        api.createTenant({
          name: 'C',
          slug: 'c',
          adminEmail: 'a@b.com',
          tier: 'FREE',
        }),
      ).rejects.toThrow(TenantApiError);
    });
  });

  describe('updateTenant', () => {
    it('PUT /tenants/{id} に提供されたフィールドのみ送るべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Updated',
          email: 'a@b.com',
          tier: 'standard',
          tenantStatus: 'Complete',
        }),
      );

      const tenant = await api.updateTenant('t-1', {
        name: 'Updated',
        tier: 'PRO',
      });

      expect(tenant?.name).toBe('Updated');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants/t-1',
        expect.objectContaining({ method: 'PUT' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ tenantName: 'Updated', tier: 'standard' });
    });

    it('adminEmail を email にマッピングして送るべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'X',
          email: 'changed@b.com',
          tier: 'basic',
          tenantStatus: 'Complete',
        }),
      );

      await api.updateTenant('t-1', { adminEmail: 'changed@b.com' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ email: 'changed@b.com' });
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue(errJson(404, '{"message":"Not found"}'));
      expect(await api.updateTenant('x', { name: 'X' })).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"message":"Server error"}'));
      await expect(api.updateTenant('t-1', { name: 'X' })).rejects.toThrow(
        TenantApiError,
      );
    });

    it('不正レスポンスは TenantApiError を投げるべき', async () => {
      mockFetch.mockResolvedValue(okJson({ invalid: 'response' }));
      await expect(api.updateTenant('t-1', { name: 'X' })).rejects.toThrow(
        TenantApiError,
      );
    });
  });

  describe('deleteTenant', () => {
    it('DELETE /tenants/{id} を URL エンコードして叩くべき', async () => {
      mockFetch.mockResolvedValue(okJson({}));
      expect(await api.deleteTenant('id with space')).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/tenants/id%20with%20space',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('404 の場合は false を返すべき', async () => {
      mockFetch.mockResolvedValue(errJson(404, '{"message":"Not found"}'));
      expect(await api.deleteTenant('x')).toBe(false);
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"message":"Server error"}'));
      await expect(api.deleteTenant('x')).rejects.toThrow(TenantApiError);
    });
  });

  describe('triggerProvisioning', () => {
    it('SBT では no-op を返すべき (provisioning は EventBridge 駆動)', async () => {
      const result = await api.triggerProvisioning('t-1');
      expect(result.success).toBe(true);
      expect(result.provisioningStatus).toBe('IN_PROGRESS');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getProvisioningStatus', () => {
    it('Complete を COMPLETED に変換すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tier: 'basic',
          tenantStatus: 'Complete',
        }),
      );

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('COMPLETED');
      expect(status?.provisioningEnabled).toBe(true);
    });

    it('In progress を IN_PROGRESS に変換すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tier: 'basic',
          tenantStatus: 'In progress',
        }),
      );

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('IN_PROGRESS');
    });

    it('Deleted を FAILED に変換すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tier: 'basic',
          tenantStatus: 'Deleted',
        }),
      );

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('FAILED');
    });

    it('未知の status は PENDING に変換すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson({
          tenantId: 't-1',
          tenantName: 'Corp',
          email: 'a@b.com',
          tier: 'basic',
          tenantStatus: 'unknown',
        }),
      );

      const status = await api.getProvisioningStatus('t-1');
      expect(status?.provisioningStatus).toBe('PENDING');
    });

    it('404 の場合は null を返すべき', async () => {
      mockFetch.mockResolvedValue(errJson(404, '{"message":"Not found"}'));
      expect(await api.getProvisioningStatus('x')).toBeNull();
    });

    it('404 以外のエラーは throw すべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"message":"Server error"}'));
      await expect(api.getProvisioningStatus('t-1')).rejects.toThrow(
        TenantApiError,
      );
    });
  });

  describe('toTenant マッピング', () => {
    it('tier=platinum は ENTERPRISE に丸めるべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'Corp',
            email: 'a@b.com',
            tier: 'platinum',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].tier).toBe('ENTERPRISE');
      expect(tenants[0].isolationModel).toBe('SILO');
    });

    it('tier 未指定は FREE にフォールバックすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'Corp',
            email: 'a@b.com',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].tier).toBe('FREE');
    });

    it('isActive=false は ARCHIVED にマッピングすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'Corp',
            email: 'a@b.com',
            tier: 'basic',
            tenantStatus: 'Deleted',
            isActive: false,
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].status).toBe('ARCHIVED');
    });

    it('スペース入りテナント名から slug を派生すべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'Hello World',
            email: 'a@b.com',
            tier: 'basic',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].slug).toBe('hello-world');
    });

    it('非 ASCII テナント名は slug を tenantId にフォールバックすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-jp-001',
            tenantName: '品質管理部',
            email: 'a@b.com',
            tier: 'basic',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].slug).toBe('t-jp-001');
    });

    it('createdAt/updatedAt 未提供は空文字にフォールバックすべき', async () => {
      mockFetch.mockResolvedValue(
        okJson([
          {
            tenantId: 't-1',
            tenantName: 'Corp',
            email: 'a@b.com',
            tier: 'basic',
            tenantStatus: 'Complete',
          },
        ]),
      );

      const tenants = await api.listTenants();
      expect(tenants[0].createdAt).toBe('');
      expect(tenants[0].updatedAt).toBe('');
    });
  });

  describe('sbtFetch エラーハンドリング', () => {
    it('JSON.message があればそれを TenantApiError のメッセージにすべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"message":"Internal error"}'));
      await expect(api.listTenants()).rejects.toThrow('Internal error');
    });

    it('JSON.error フィールドがあればそれを使うべき', async () => {
      mockFetch.mockResolvedValue(errJson(400, '{"error":"Bad request"}'));
      await expect(api.listTenants()).rejects.toThrow('Bad request');
    });

    it('JSON に message/error がなければデフォルトメッセージを使うべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, '{"foo":"bar"}'));
      await expect(api.listTenants()).rejects.toThrow('SBT API request failed');
    });

    it('JSON パースに失敗してもデフォルトメッセージを使うべき', async () => {
      mockFetch.mockResolvedValue(errJson(500, 'not json'));
      await expect(api.listTenants()).rejects.toThrow('SBT API request failed');
    });

    it('トークンが null なら Authorization ヘッダーなしで呼ぶべき', async () => {
      const noAuthApi = createSbtTenantApi(
        'https://api.example.com',
        async () => null,
      );
      mockFetch.mockResolvedValue(okJson({ data: [] }));

      await noAuthApi.listTenants();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
