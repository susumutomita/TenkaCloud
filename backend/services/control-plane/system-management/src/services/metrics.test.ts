import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsService } from './metrics';

const mockAuditLogRepository = vi.hoisted(() => ({
  listByTenant: vi.fn(),
}));

const mockSystemSettingRepository = vi.hoisted(() => ({
  listAll: vi.fn(),
}));

const mockServiceHealthRepository = vi.hoisted(() => ({
  upsert: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  auditLogRepository: mockAuditLogRepository,
  systemSettingRepository: mockSystemSettingRepository,
  serviceHealthRepository: mockServiceHealthRepository,
}));

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('collectMetrics', () => {
    it('正常にメトリクスを収集すべき', async () => {
      mockServiceHealthRepository.upsert.mockResolvedValue({
        id: 'health-1',
        serviceName: 'system-management',
        status: 'active',
        lastCheck: new Date(),
        details: {},
      });
      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [{ id: 'log-1' }],
        lastKey: undefined,
      });
      mockSystemSettingRepository.listAll.mockResolvedValue([
        { key: 'setting-1' },
        { key: 'setting-2' },
      ]);

      const result = await service.collectMetrics();

      expect(result.timestamp).toBeDefined();
      expect(result.system.uptime).toBeGreaterThanOrEqual(0);
      expect(result.system.memory.heapUsed).toBeGreaterThan(0);
      expect(result.system.memory.heapTotal).toBeGreaterThan(0);
      expect(result.system.memory.usagePercent).toBeGreaterThan(0);
      expect(result.system.cpu.user).toBeGreaterThanOrEqual(0);
      expect(result.system.cpu.system).toBeGreaterThanOrEqual(0);
      expect(result.database.connectionStatus).toBe('connected');
      expect(result.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.application.auditLogsCount).toBe(-1); // 集計不可
      expect(result.application.settingsCount).toBe(2);
    });

    it('データベース接続エラー時も他のメトリクスを収集すべき', async () => {
      mockServiceHealthRepository.upsert.mockRejectedValue(
        new Error('Connection error')
      );
      mockAuditLogRepository.listByTenant.mockResolvedValue({
        logs: [],
        lastKey: undefined,
      });
      mockSystemSettingRepository.listAll.mockResolvedValue([]);

      const result = await service.collectMetrics();

      expect(result.database.connectionStatus).toBe('disconnected');
      expect(result.database.latencyMs).toBe(-1);
      expect(result.system.memory.heapUsed).toBeGreaterThan(0);
    });
  });
});
