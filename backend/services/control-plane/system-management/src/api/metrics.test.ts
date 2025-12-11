import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as metricsServiceModule from '../services/metrics';

vi.mock('../services/metrics');

describe('Metrics API', () => {
  let app: Hono;
  let mockCollectMetrics: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCollectMetrics = vi.fn();

    vi.mocked(metricsServiceModule.MetricsService).mockImplementation(
      () =>
        ({
          collectMetrics: mockCollectMetrics,
        }) as unknown as metricsServiceModule.MetricsService
    );

    const { metricsRoutes } = await import('./metrics');
    app = new Hono();
    app.route('/', metricsRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /metrics', () => {
    it('メトリクスを返すべき', async () => {
      const mockMetrics = {
        timestamp: '2024-01-01T00:00:00.000Z',
        system: {
          uptime: 3600,
          memory: {
            heapUsed: 50000000,
            heapTotal: 100000000,
            external: 1000000,
            rss: 150000000,
            usagePercent: 50,
          },
          cpu: { user: 100, system: 50 },
        },
        database: {
          connectionStatus: 'connected',
          latencyMs: 5,
        },
        application: {
          auditLogsCount: 100,
          settingsCount: 10,
        },
      };

      mockCollectMetrics.mockResolvedValue(mockMetrics);

      const res = await app.request('/metrics');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(mockMetrics);
    });
  });
});
