import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context, Next } from 'hono';
import { auditMiddleware } from './audit';
import { createLogger } from '../lib/logger';

// Mock logger
vi.mock('../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('監査ログミドルウェア', () => {
  let mockContext: Partial<Context>;
  let mockNext: Next;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(createLogger).mockReturnValue(mockLogger);

    mockNext = vi.fn(async () => {});

    mockContext = {
      req: {
        method: 'GET',
        path: '/api/tenants',
        header: vi.fn((name: string) => {
          if (name === 'user-agent') return 'Test Agent';
          if (name === 'x-forwarded-for') return '192.168.1.1';
          return null;
        }),
        raw: {
          clone: () => ({
            json: vi.fn().mockResolvedValue({}),
          }),
        } as any,
      } as any,
      get: vi.fn((key: string) => {
        if (key === 'user') {
          return {
            id: 'test-user-id',
            email: 'test@example.com',
            username: 'testuser',
            roles: ['platform-admin'],
          };
        }
        return undefined;
      }),
      res: {
        status: 200,
      } as any,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('基本的な監査ログ記録', () => {
    it('成功したリクエストをINFOレベルでログに記録するべき', async () => {
      await auditMiddleware(mockContext as Context, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.action).toBe('list');
      expect(logEntry.resource).toBe('tenants');
      expect(logEntry.method).toBe('GET');
      expect(logEntry.path).toBe('/api/tenants');
      expect(logEntry.statusCode).toBe(200);
      expect(logEntry.userId).toBe('test-user-id');
    });

    it('PII保護が有効な場合userEmailをログに記録すべき', async () => {
      // Set LOG_PII environment variable
      const originalEnv = process.env.LOG_PII;
      process.env.LOG_PII = 'true';

      await auditMiddleware(mockContext as Context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.userEmail).toBe('test@example.com');

      // Restore original environment
      process.env.LOG_PII = originalEnv;
    });

    it('PII保護が無効な場合userEmailをログに記録しないべき', async () => {
      // Ensure LOG_PII is not set or false
      const originalEnv = process.env.LOG_PII;
      delete process.env.LOG_PII;

      await auditMiddleware(mockContext as Context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.userEmail).toBeUndefined();

      // Restore original environment
      process.env.LOG_PII = originalEnv;
    });

    it('4xxエラーをWARNレベルでログに記録するべき', async () => {
      mockContext.res = { status: 404 } as any;

      await auditMiddleware(mockContext as Context, mockNext);

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();

      const logEntry = mockLogger.warn.mock.calls[0][0];
      expect(logEntry.statusCode).toBe(404);
    });

    it('5xxエラーをERRORレベルでログに記録するべき', async () => {
      mockContext.res = { status: 500 } as any;

      await auditMiddleware(mockContext as Context, mockNext);

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();

      const logEntry = mockLogger.error.mock.calls[0][0];
      expect(logEntry.statusCode).toBe(500);
    });
  });

  describe('リソース解析', () => {
    const createMockReq = (method: string, path: string) => ({
      method,
      path,
      header: vi.fn((name: string) => {
        if (name === 'user-agent') return 'Test Agent';
        if (name === 'x-forwarded-for') return '192.168.1.1';
        return null;
      }),
      raw: {
        clone: () => ({
          json: vi.fn().mockResolvedValue({}),
        }),
      } as any,
    });

    it('IDなしのパス /api/tenants を正しく解析するべき', async () => {
      const context = {
        ...mockContext,
        req: createMockReq('GET', '/api/tenants'),
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.resource).toBe('tenants');
      expect(logEntry.resourceId).toBeUndefined();
      expect(logEntry.action).toBe('list');
    });

    it('UUIDを含むパス /api/tenants/:id を正しく解析するべき', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440000';
      const context = {
        ...mockContext,
        req: createMockReq('GET', `/api/tenants/${testUuid}`),
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.resource).toBe('tenants');
      expect(logEntry.resourceId).toBe(testUuid);
      expect(logEntry.action).toBe('view');
    });

    it('POSTリクエストをcreateアクションとして記録するべき', async () => {
      const context = {
        ...mockContext,
        req: createMockReq('POST', '/api/tenants'),
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.action).toBe('create');
    });

    it('PATCHリクエストをupdateアクションとして記録するべき', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440000';
      const context = {
        ...mockContext,
        req: createMockReq('PATCH', `/api/tenants/${testUuid}`),
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.action).toBe('update');
    });

    it('DELETEリクエストをdeleteアクションとして記録するべき', async () => {
      const testUuid = '550e8400-e29b-41d4-a716-446655440000';
      const context = {
        ...mockContext,
        req: createMockReq('DELETE', `/api/tenants/${testUuid}`),
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.action).toBe('delete');
    });
  });

  describe('センシティブデータのリダクション', () => {
    it('POSTリクエストでセンシティブフィールドをマスクするべき', async () => {
      const sensitiveData = {
        name: 'Test Tenant',
        password: 'secret123',
        token: 'bearer-token',
        apiKey: 'api-key-123',
      };

      const context = {
        ...mockContext,
        req: {
          method: 'POST',
          path: '/api/tenants',
          header: vi.fn((name: string) => {
            if (name === 'user-agent') return 'Test Agent';
            if (name === 'x-forwarded-for') return '192.168.1.1';
            return null;
          }),
          raw: {
            clone: () => ({
              json: vi.fn().mockResolvedValue(sensitiveData),
            }),
          } as any,
        },
      } as unknown as Context;

      await auditMiddleware(context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.requestBody.name).toBe('Test Tenant');
      expect(logEntry.requestBody.password).toBe('[REDACTED]');
      expect(logEntry.requestBody.token).toBe('[REDACTED]');
      expect(logEntry.requestBody.apiKey).toBe('[REDACTED]');
    });
  });

  describe('レスポンスタイム計測', () => {
    it('レスポンスタイムを記録するべき', async () => {
      // Simulate delay
      mockNext = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await auditMiddleware(mockContext as Context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.responseTime).toBeGreaterThan(0);
    });
  });

  describe('IPアドレスとユーザーエージェント', () => {
    it('x-forwarded-forヘッダーからIPアドレスを記録するべき', async () => {
      await auditMiddleware(mockContext as Context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.ipAddress).toBe('192.168.1.1');
    });

    it('user-agentヘッダーを記録するべき', async () => {
      await auditMiddleware(mockContext as Context, mockNext);

      const logEntry = mockLogger.info.mock.calls[0][0];
      expect(logEntry.userAgent).toBe('Test Agent');
    });
  });
});
