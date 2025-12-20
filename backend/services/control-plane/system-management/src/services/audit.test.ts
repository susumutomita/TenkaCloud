import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditService } from './audit';
import type { AuditLog } from '@tenkacloud/dynamodb';

const mockAuditLogRepository = vi.hoisted(() => ({
  create: vi.fn(),
  listByTenant: vi.fn(),
  listByUser: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  auditLogRepository: mockAuditLogRepository,
}));

const createMockAuditLog = (overrides: Partial<AuditLog> = {}): AuditLog => ({
  id: 'log-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  action: 'CREATE',
  resourceType: 'USER',
  resourceId: 'resource-1',
  details: { key: 'value' },
  ipAddress: '192.168.1.1',
  userAgent: 'Mozilla/5.0',
  createdAt: new Date(),
  ...overrides,
});

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
      const mockLog = createMockAuditLog();

      mockAuditLogRepository.create.mockResolvedValue(mockLog);

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
      expect(mockAuditLogRepository.create).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'CREATE',
        resourceType: 'USER',
        resourceId: 'resource-1',
        details: { key: 'value' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('オプションフィールドなしでも監査ログを作成すべき', async () => {
      const mockLog = createMockAuditLog({
        tenantId: undefined,
        userId: undefined,
        action: 'ACCESS',
        resourceType: 'SYSTEM',
        resourceId: undefined,
        details: undefined,
        ipAddress: undefined,
        userAgent: undefined,
      });

      mockAuditLogRepository.create.mockResolvedValue(mockLog);

      const result = await service.createLog({
        action: 'ACCESS',
        resourceType: 'SYSTEM',
      });

      expect(result).toEqual(mockLog);
    });
  });

  describe('listLogs', () => {
    it('テナントで監査ログ一覧を取得すべき', async () => {
      const mockLogs = [createMockAuditLog()];

      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: mockLogs,
        lastKey: undefined,
      });

      const result = await service.listLogs({ tenantId: 'tenant-1' });

      expect(result.logs).toEqual(mockLogs);
      expect(result.total).toBe(1);
      expect(mockAuditLogRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ limit: 50 })
      );
    });

    it('ユーザーで監査ログ一覧を取得すべき', async () => {
      const mockLogs = [createMockAuditLog()];

      mockAuditLogRepository.listByUser.mockResolvedValue({
        logs: mockLogs,
        lastKey: undefined,
      });

      const result = await service.listLogs({ userId: 'user-1' });

      expect(result.logs).toEqual(mockLogs);
      expect(result.total).toBe(1);
      expect(mockAuditLogRepository.listByUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ limit: 50 })
      );
    });

    it('フィルタ条件で監査ログを絞り込むべき', async () => {
      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const result = await service.listLogs({
        tenantId: 'tenant-1',
        action: 'CREATE',
        resourceType: 'USER',
        limit: 10,
      });

      expect(result.logs).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(mockAuditLogRepository.listByTenant).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'USER',
          limit: 10,
        })
      );
    });

    it('日付フィルタで監査ログを絞り込むべき', async () => {
      const pastDate = new Date('2024-01-01');
      const futureDate = new Date('2024-12-31');
      const mockLog = createMockAuditLog({
        createdAt: new Date('2024-06-15'),
      });

      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [mockLog],
        lastKey: undefined,
      });

      const result = await service.listLogs({
        tenantId: 'tenant-1',
        startDate: pastDate,
        endDate: futureDate,
      });

      expect(result.logs).toHaveLength(1);
    });
  });

  describe('getLogById', () => {
    it('IDで監査ログを取得すべき', async () => {
      const mockLog = createMockAuditLog({ id: 'log-1' });

      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [mockLog],
        lastKey: undefined,
      });

      const result = await service.getLogById('log-1');

      expect(result).toEqual(mockLog);
    });

    it('存在しないIDの場合、nullを返すべき', async () => {
      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });

      const result = await service.getLogById('non-existent');

      expect(result).toBeNull();
    });
  });
});
