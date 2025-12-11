import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsService } from './metrics';
import { prisma } from '../lib/prisma';

vi.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    auditLog: {
      count: vi.fn(),
    },
    systemSetting: {
      count: vi.fn(),
    },
  },
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
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);
      vi.mocked(prisma.auditLog.count).mockResolvedValue(100);
      vi.mocked(prisma.systemSetting.count).mockResolvedValue(10);

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
      expect(result.application.auditLogsCount).toBe(100);
      expect(result.application.settingsCount).toBe(10);
    });

    it('データベース接続エラー時も他のメトリクスを収集すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValue(
        new Error('Connection error')
      );
      vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
      vi.mocked(prisma.systemSetting.count).mockResolvedValue(0);

      const result = await service.collectMetrics();

      expect(result.database.connectionStatus).toBe('disconnected');
      expect(result.database.latencyMs).toBe(-1);
      expect(result.system.memory.heapUsed).toBeGreaterThan(0);
    });
  });
});
