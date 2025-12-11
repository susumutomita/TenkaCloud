import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditService } from './audit';
import { prisma } from '../lib/prisma';

vi.mock('../lib/prisma', () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(() => {
    service = new AuditService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createLog', () => {
    it('監査ログを作成すべき', async () => {
      const mockLog = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE' as const,
        resourceType: 'USER' as const,
        resourceId: 'resource-1',
        details: { key: 'value' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        createdAt: new Date(),
      };

      vi.mocked(prisma.auditLog.create).mockResolvedValue(mockLog);

      const result = await service.createLog({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE',
        resourceType: 'USER',
        resourceId: 'resource-1',
        details: { key: 'value' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(result).toEqual(mockLog);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          action: 'CREATE',
          resourceType: 'USER',
          resourceId: 'resource-1',
          details: { key: 'value' },
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
        },
      });
    });

    it('オプションフィールドなしでも監査ログを作成すべき', async () => {
      const mockLog = {
        id: 'log-2',
        tenantId: null,
        userId: null,
        action: 'ACCESS' as const,
        resourceType: 'SYSTEM' as const,
        resourceId: null,
        details: null,
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
      };

      vi.mocked(prisma.auditLog.create).mockResolvedValue(mockLog);

      const result = await service.createLog({
        action: 'ACCESS',
        resourceType: 'SYSTEM',
      });

      expect(result).toEqual(mockLog);
    });
  });

  describe('listLogs', () => {
    it('監査ログ一覧を取得すべき', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          action: 'CREATE' as const,
          resourceType: 'USER' as const,
          resourceId: 'resource-1',
          details: null,
          ipAddress: null,
          userAgent: null,
          createdAt: new Date(),
        },
      ];

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue(mockLogs);
      vi.mocked(prisma.auditLog.count).mockResolvedValue(1);

      const result = await service.listLogs({ tenantId: 'tenant-1' });

      expect(result.logs).toEqual(mockLogs);
      expect(result.total).toBe(1);
    });

    it('フィルタ条件で監査ログを絞り込むべき', async () => {
      const mockLogs: typeof prisma.auditLog.findMany extends (
        ...args: unknown[]
      ) => Promise<infer T>
        ? T
        : never = [];

      vi.mocked(prisma.auditLog.findMany).mockResolvedValue(mockLogs);
      vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

      const result = await service.listLogs({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE',
        resourceType: 'USER',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        limit: 10,
        offset: 5,
      });

      expect(result.logs).toEqual([]);
      expect(result.total).toBe(0);
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          action: 'CREATE',
          resourceType: 'USER',
        }),
        take: 10,
        skip: 5,
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('getLogById', () => {
    it('IDで監査ログを取得すべき', async () => {
      const mockLog = {
        id: 'log-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE' as const,
        resourceType: 'USER' as const,
        resourceId: 'resource-1',
        details: null,
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
      };

      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue(mockLog);

      const result = await service.getLogById('log-1');

      expect(result).toEqual(mockLog);
      expect(prisma.auditLog.findUnique).toHaveBeenCalledWith({
        where: { id: 'log-1' },
      });
    });

    it('存在しないIDの場合、nullを返すべき', async () => {
      vi.mocked(prisma.auditLog.findUnique).mockResolvedValue(null);

      const result = await service.getLogById('non-existent');

      expect(result).toBeNull();
    });
  });
});
