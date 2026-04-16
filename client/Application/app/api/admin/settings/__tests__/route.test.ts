import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';

const mockGetAdminSession = vi.fn<() => Promise<Session | null>>();
const mockServerApiRequest = vi.fn();

vi.mock('@/auth', () => ({
  authSkipEnabled: true,
}));

vi.mock('@/lib/api/server', () => ({
  getAdminSession: () => mockGetAdminSession(),
  serverApiRequest: (...args: unknown[]) => mockServerApiRequest(...args),
  unauthorizedResponse: (msg = 'Unauthorized') =>
    new Response(JSON.stringify({ error: msg }), { status: 401 }),
  forbiddenResponse: (msg = 'Forbidden') =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
  badRequestResponse: (msg = 'Bad Request') =>
    new Response(JSON.stringify({ error: msg }), { status: 400 }),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
}));

const adminSession: Session = {
  user: { name: 'Admin', email: 'admin@example.com' },
  expires: new Date().toISOString(),
  roles: ['admin'],
};

describe('Admin Settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (
      globalThis as typeof globalThis & {
        __TENKACLOUD_DEV_SETTINGS__?: unknown;
      }
    ).__TENKACLOUD_DEV_SETTINGS__;
  });

  describe('GET /api/admin/settings', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Authentication required');
    });

    it('現在の設定を取得すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const mockSettings = {
        tenantName: 'テスト組織',
        slug: 'test-org',
        apiKey: 'sk-****1234',
      };
      mockServerApiRequest.mockResolvedValue(mockSettings);

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(mockSettings);
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('API Error'));

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to fetch settings');
    });

    it('Error 以外の例外の場合はデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue('string error');

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to fetch settings');
    });

    it('network error 時は local dev settings を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          tenantName: 'Dev Tenant',
          slug: 'dev-tenant',
          apiKey: expect.stringMatching(/^sk-dev-/),
        }),
      );
    });
  });

  describe('PUT /api/admin/settings', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ tenantName: 'New Name' }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(401);
    });

    it('テナント名が空の場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ tenantName: '  ' }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Tenant name cannot be empty');
    });

    it('スラッグが空の場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ slug: '' }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Slug cannot be empty');
    });

    it('設定を更新して結果を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const updatedSettings = {
        tenantName: '更新組織',
        slug: 'updated-org',
        apiKey: 'sk-****5678',
      };
      mockServerApiRequest.mockResolvedValue(updatedSettings);

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          tenantName: '更新組織',
          slug: 'updated-org',
        }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(updatedSettings);
      expect(mockServerApiRequest).toHaveBeenCalledWith('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          tenantName: '更新組織',
          slug: 'updated-org',
        }),
      });
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Update failed'));

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ tenantName: 'Valid Name' }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to update settings');
    });

    it('Error 以外の例外の場合はデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue('string error');

      const { PUT } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ tenantName: 'Valid Name' }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to update settings');
    });

    it('network error 時は local dev settings を更新すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

      const { PUT } = await import('../route');
      const response = await PUT(
        new NextRequest('http://localhost/api/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({ tenantName: 'Local Tenant', slug: 'local' }),
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          tenantName: 'Local Tenant',
          slug: 'local',
          apiKey: expect.stringMatching(/^sk-dev-/),
        }),
      );
    });
  });

  describe('POST /api/admin/settings', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate-api-key' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('action が未指定の場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Action is required');
    });

    it('API キーを再生成すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const result = {
        tenantName: 'テスト組織',
        slug: 'test-org',
        apiKey: 'sk-****new1',
      };
      mockServerApiRequest.mockResolvedValue(result);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate-api-key' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/settings/api-key',
        { method: 'POST' },
      );
    });

    it('確認トークンなしの全データ削除は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete-all-data' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Confirmation token must be "DELETE" to proceed');
    });

    it('不正な確認トークンでの全データ削除は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete-all-data',
          confirmationToken: 'WRONG',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('正しい確認トークンで全データを削除すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({ success: true });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete-all-data',
          confirmationToken: 'DELETE',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/settings/delete-all-data',
        {
          method: 'POST',
          body: JSON.stringify({ confirmationToken: 'DELETE' }),
        },
      );
    });

    it('不明なアクションの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'unknown-action' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Unknown action: unknown-action');
    });

    it('API キー再生成でエラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Regenerate failed'));

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate-api-key' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to execute action');
    });

    it('Error 以外の例外の場合はデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue('string error');

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate-api-key' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to execute action');
    });

    it('network error 時は local dev API キーを再生成すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

      const { GET, POST } = await import('../route');

      const before = await GET();
      const beforeData = await before.json();

      const response = await POST(
        new NextRequest('http://localhost/api/admin/settings', {
          method: 'POST',
          body: JSON.stringify({ action: 'regenerate-api-key' }),
        }),
      );

      expect(response.status).toBe(200);
      const afterData = await response.json();
      expect(afterData.apiKey).toMatch(/^sk-dev-/);
      expect(afterData.apiKey).not.toBe(beforeData.apiKey);
    });

    it('network error 時の delete-all-data は local dev events を削除すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

      (
        globalThis as typeof globalThis & {
          __TENKACLOUD_DEV_EVENTS__?: unknown[];
        }
      ).__TENKACLOUD_DEV_EVENTS__ = [
        {
          id: 'event-1',
          slug: 'test-event',
          name: 'Test Event',
          type: 'gameday',
          status: 'draft',
          startTime: '2026-04-09T00:00:00.000Z',
          endTime: '2026-04-10T23:59:59.000Z',
          timezone: 'Asia/Tokyo',
          participantType: 'individual',
          cloudProvider: 'local',
          regions: ['local'],
          scoringType: 'realtime',
          leaderboardVisible: true,
          problemCount: 0,
          participantCount: 0,
          isRegistered: false,
          createdAt: '2026-04-09T00:00:00.000Z',
        },
      ];

      const { POST } = await import('../route');
      const response = await POST(
        new NextRequest('http://localhost/api/admin/settings', {
          method: 'POST',
          body: JSON.stringify({
            action: 'delete-all-data',
            confirmationToken: 'DELETE',
          }),
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(
        (
          globalThis as typeof globalThis & {
            __TENKACLOUD_DEV_EVENTS__?: unknown[];
          }
        ).__TENKACLOUD_DEV_EVENTS__,
      ).toEqual([]);
    });
  });
});
