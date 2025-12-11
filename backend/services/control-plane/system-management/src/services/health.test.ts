import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthService } from './health';
import { prisma } from '../lib/prisma';

vi.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(() => {
    service = new HealthService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkHealth', () => {
    it('データベースが正常な場合、healthy ステータスを返すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);

      const result = await service.checkHealth();

      expect(result.status).toBe('healthy');
      expect(result.checks.database.status).toBe('healthy');
      expect(result.checks.database.latency).toBeGreaterThanOrEqual(0);
      expect(result.checks.memory.status).toBe('healthy');
      expect(result.version).toBe('0.1.0');
      expect(result.timestamp).toBeDefined();
    });

    it('データベース接続エラーの場合、unhealthy ステータスを返すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValue(
        new Error('Connection error')
      );

      const result = await service.checkHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.database.status).toBe('unhealthy');
      expect(result.checks.database.message).toBe('データベース接続エラー');
    });

    it('メモリ使用率が90%を超えた場合、unhealthy ステータスを返すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);

      // メモリ使用率を90%以上にモック
      const originalMemoryUsage = process.memoryUsage;
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 95000000,
        heapTotal: 100000000,
        external: 1000000,
        rss: 150000000,
        arrayBuffers: 0,
      });

      const result = await service.checkHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.memory.status).toBe('unhealthy');
      expect(result.checks.memory.message).toContain('メモリ使用率が高い');

      vi.spyOn(process, 'memoryUsage').mockRestore();
    });
  });

  describe('checkReadiness', () => {
    it('データベースが正常な場合、ready: true を返すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);

      const result = await service.checkReadiness();

      expect(result.ready).toBe(true);
      expect(result.checks.database).toBe(true);
      expect(result.timestamp).toBeDefined();
    });

    it('データベース接続エラーの場合、ready: false を返すべき', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValue(
        new Error('Connection error')
      );

      const result = await service.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.checks.database).toBe(false);
    });
  });
});
