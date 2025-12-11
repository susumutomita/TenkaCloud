import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { Prisma } from '@prisma/client';
import * as settingsServiceModule from '../services/settings';

vi.mock('../services/settings');

describe('Settings API', () => {
  let app: Hono;
  let mockCreateSetting: ReturnType<typeof vi.fn>;
  let mockGetSettingByKey: ReturnType<typeof vi.fn>;
  let mockUpdateSetting: ReturnType<typeof vi.fn>;
  let mockDeleteSetting: ReturnType<typeof vi.fn>;
  let mockListSettings: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCreateSetting = vi.fn();
    mockGetSettingByKey = vi.fn();
    mockUpdateSetting = vi.fn();
    mockDeleteSetting = vi.fn();
    mockListSettings = vi.fn();

    vi.mocked(settingsServiceModule.SettingsService).mockImplementation(
      () =>
        ({
          createSetting: mockCreateSetting,
          getSettingByKey: mockGetSettingByKey,
          updateSetting: mockUpdateSetting,
          deleteSetting: mockDeleteSetting,
          listSettings: mockListSettings,
        }) as unknown as settingsServiceModule.SettingsService
    );

    const { settingsRoutes } = await import('./settings');
    app = new Hono();
    app.route('/', settingsRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /settings', () => {
    it('設定を作成すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
        updatedAt: new Date().toISOString(),
        updatedBy: 'user-1',
      };

      mockCreateSetting.mockResolvedValue(mockSetting);

      const res = await app.request('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.key).toBe('app.theme');
    });

    it('x-user-id ヘッダーがない場合、401を返すべき', async () => {
      const res = await app.request('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('認証が必要です (x-user-id ヘッダー)');
    });

    it('空の x-user-id ヘッダーの場合、401を返すべき', async () => {
      const res = await app.request('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': '   ',
        },
        body: JSON.stringify({
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('無効なキーの場合、400を返すべき', async () => {
      const res = await app.request('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({
          key: '',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('その他のエラーの場合、エラーを再スローすべき', async () => {
      mockCreateSetting.mockRejectedValue(new Error('Unknown database error'));

      const res = await app.request('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(500);
    });

    it('重複キーの場合 (P2002)、409を返すべき', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '5.0.0' }
      );
      mockCreateSetting.mockRejectedValue(prismaError);

      const res = await app.request('/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({
          key: 'app.theme',
          value: { dark: true },
          category: 'appearance',
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('設定キーが既に存在します');
    });
  });

  describe('GET /settings', () => {
    it('設定一覧を返すべき', async () => {
      const mockResult = {
        settings: [
          {
            id: 'setting-1',
            key: 'app.theme',
            value: { dark: true },
            category: 'appearance',
          },
        ],
        total: 1,
      };

      mockListSettings.mockResolvedValue(mockResult);

      const res = await app.request('/settings?category=appearance');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings).toHaveLength(1);
    });

    it('無効なクエリパラメータの場合、400を返すべき', async () => {
      const res = await app.request('/settings?limit=0');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });
  });

  describe('GET /settings/:key', () => {
    it('キーで設定を取得すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: true },
        category: 'appearance',
      };

      mockGetSettingByKey.mockResolvedValue(mockSetting);

      const res = await app.request('/settings/app.theme');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.key).toBe('app.theme');
    });

    it('存在しないキーの場合、404を返すべき', async () => {
      mockGetSettingByKey.mockResolvedValue(null);

      const res = await app.request('/settings/non-existent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('設定が見つかりません');
    });
  });

  describe('PUT /settings/:key', () => {
    it('x-user-id ヘッダーがない場合、401を返すべき', async () => {
      const res = await app.request('/settings/app.theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { dark: false } }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('認証が必要です (x-user-id ヘッダー)');
    });

    it('無効なボディ形式の場合、400を返すべき', async () => {
      const res = await app.request('/settings/app.theme', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify('not an object'),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('設定を更新すべき', async () => {
      const mockSetting = {
        id: 'setting-1',
        key: 'app.theme',
        value: { dark: false },
        category: 'appearance',
      };

      mockUpdateSetting.mockResolvedValue(mockSetting);

      const res = await app.request('/settings/app.theme', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({ value: { dark: false } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.value).toEqual({ dark: false });
    });

    it('存在しないキーの場合 (P2025)、404を返すべき', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Record to update not found',
        { code: 'P2025', clientVersion: '5.0.0' }
      );
      mockUpdateSetting.mockRejectedValue(prismaError);

      const res = await app.request('/settings/non-existent', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({ value: { dark: false } }),
      });

      expect(res.status).toBe(404);
    });

    it('その他のエラーの場合、エラーを再スローすべき', async () => {
      mockUpdateSetting.mockRejectedValue(new Error('Unknown database error'));

      const res = await app.request('/settings/app.theme', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'user-1',
        },
        body: JSON.stringify({ value: { dark: false } }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /settings/:key', () => {
    it('x-user-id ヘッダーがない場合、401を返すべき', async () => {
      const res = await app.request('/settings/app.theme', {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('認証が必要です (x-user-id ヘッダー)');
    });

    it('設定を削除すべき', async () => {
      mockDeleteSetting.mockResolvedValue(undefined);

      const res = await app.request('/settings/app.theme', {
        method: 'DELETE',
        headers: { 'x-user-id': 'user-1' },
      });

      expect(res.status).toBe(204);
    });

    it('IP アドレスと User-Agent を渡すべき', async () => {
      mockDeleteSetting.mockResolvedValue(undefined);

      await app.request('/settings/app.theme', {
        method: 'DELETE',
        headers: {
          'x-user-id': 'user-1',
          'x-forwarded-for': '192.168.1.1',
          'user-agent': 'Test Agent',
        },
      });

      expect(mockDeleteSetting).toHaveBeenCalledWith('app.theme', {
        userId: 'user-1',
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
      });
    });

    it('存在しないキーの場合 (P2025)、404を返すべき', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        'Record to delete does not exist',
        { code: 'P2025', clientVersion: '5.0.0' }
      );
      mockDeleteSetting.mockRejectedValue(prismaError);

      const res = await app.request('/settings/non-existent', {
        method: 'DELETE',
        headers: { 'x-user-id': 'user-1' },
      });

      expect(res.status).toBe(404);
    });

    it('その他のエラーの場合、エラーを再スローすべき', async () => {
      mockDeleteSetting.mockRejectedValue(new Error('Unknown database error'));

      const res = await app.request('/settings/app.theme', {
        method: 'DELETE',
        headers: { 'x-user-id': 'user-1' },
      });

      expect(res.status).toBe(500);
    });
  });
});
