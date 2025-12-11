import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as auditServiceModule from '../services/audit';

vi.mock('../services/audit');

describe('Audit API', () => {
  let app: Hono;
  let mockCreateLog: ReturnType<typeof vi.fn>;
  let mockListLogs: ReturnType<typeof vi.fn>;
  let mockGetLogById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCreateLog = vi.fn();
    mockListLogs = vi.fn();
    mockGetLogById = vi.fn();

    vi.mocked(auditServiceModule.AuditService).mockImplementation(
      () =>
        ({
          createLog: mockCreateLog,
          listLogs: mockListLogs,
          getLogById: mockGetLogById,
        }) as unknown as auditServiceModule.AuditService
    );

    const { auditRoutes } = await import('./audit');
    app = new Hono();
    app.route('/', auditRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /audit/logs', () => {
    it('監査ログを作成すべき', async () => {
      const mockLog = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE',
        resourceType: 'USER',
        resourceId: 'resource-1',
        details: { key: 'value' },
        ipAddress: '192.168.1.1',
        userAgent: 'Test Agent',
        createdAt: new Date().toISOString(),
      };

      mockCreateLog.mockResolvedValue(mockLog);

      const res = await app.request('/audit/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
          'user-agent': 'Test Agent',
        },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
          action: 'CREATE',
          resourceType: 'USER',
          resourceId: 'resource-1',
          details: { key: 'value' },
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('log-1');
    });

    it('x-forwarded-for がない場合 x-real-ip を使用すべき', async () => {
      const mockLog = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE',
        resourceType: 'USER',
        resourceId: 'resource-1',
        details: { key: 'value' },
        ipAddress: '10.0.0.1',
        userAgent: 'Test Agent',
        createdAt: new Date().toISOString(),
      };

      mockCreateLog.mockResolvedValue(mockLog);

      const res = await app.request('/audit/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-real-ip': '10.0.0.1',
          'user-agent': 'Test Agent',
        },
        body: JSON.stringify({
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440001',
          action: 'CREATE',
          resourceType: 'USER',
          resourceId: 'resource-1',
          details: { key: 'value' },
        }),
      });

      expect(res.status).toBe(201);
      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '10.0.0.1',
        })
      );
    });

    it('無効なアクションの場合、400を返すべき', async () => {
      const res = await app.request('/audit/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'INVALID_ACTION',
          resourceType: 'USER',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('無効な JSON の場合、400を返すべき', async () => {
      const res = await app.request('/audit/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json {',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('無効な JSON 形式です');
    });
  });

  describe('GET /audit/logs', () => {
    it('監査ログ一覧を返すべき', async () => {
      const mockResult = {
        logs: [
          {
            id: 'log-1',
            action: 'CREATE',
            resourceType: 'USER',
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
      };

      mockListLogs.mockResolvedValue(mockResult);

      const res = await app.request(
        '/audit/logs?tenantId=550e8400-e29b-41d4-a716-446655440000&limit=10'
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('フィルタ付きで監査ログ一覧を返すべき', async () => {
      mockListLogs.mockResolvedValue({ logs: [], total: 0 });

      const res = await app.request(
        '/audit/logs?action=CREATE&resourceType=USER&limit=50&offset=0'
      );

      expect(res.status).toBe(200);
      expect(mockListLogs).toHaveBeenCalled();
    });

    it('無効なクエリパラメータの場合、400を返すべき', async () => {
      const res = await app.request('/audit/logs?tenantId=invalid-uuid');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('バリデーションエラー');
    });

    it('日付範囲でフィルタできるべき', async () => {
      mockListLogs.mockResolvedValue({ logs: [], total: 0 });

      const res = await app.request(
        '/audit/logs?startDate=2024-01-01T00:00:00.000Z&endDate=2024-12-31T23:59:59.999Z'
      );

      expect(res.status).toBe(200);
      expect(mockListLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
        })
      );
    });
  });

  describe('GET /audit/logs/:id', () => {
    it('IDで監査ログを取得すべき', async () => {
      const mockLog = {
        id: 'log-1',
        action: 'CREATE',
        resourceType: 'USER',
        createdAt: new Date().toISOString(),
      };

      mockGetLogById.mockResolvedValue(mockLog);

      const res = await app.request('/audit/logs/log-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('log-1');
    });

    it('存在しないIDの場合、404を返すべき', async () => {
      mockGetLogById.mockResolvedValue(null);

      const res = await app.request('/audit/logs/non-existent');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('監査ログが見つかりません');
    });
  });
});
