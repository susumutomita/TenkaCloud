import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import * as healthServiceModule from '../services/health';

vi.mock('../services/health');

describe('Health API', () => {
  let app: Hono;
  let mockCheckHealth: ReturnType<typeof vi.fn>;
  let mockCheckReadiness: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockCheckHealth = vi.fn();
    mockCheckReadiness = vi.fn();

    vi.mocked(healthServiceModule.HealthService).mockImplementation(
      () =>
        ({
          checkHealth: mockCheckHealth,
          checkReadiness: mockCheckReadiness,
        }) as unknown as healthServiceModule.HealthService
    );

    const { healthRoutes } = await import('./health');
    app = new Hono();
    app.route('/', healthRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('healthy 状態の場合、200を返すべき', async () => {
      mockCheckHealth.mockResolvedValue({
        status: 'healthy',
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        checks: {
          database: { status: 'healthy', latency: 10 },
          memory: { status: 'healthy', message: '100MB / 500MB' },
        },
      });

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
    });

    it('unhealthy 状態の場合、503を返すべき', async () => {
      mockCheckHealth.mockResolvedValue({
        status: 'unhealthy',
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '0.1.0',
        checks: {
          database: { status: 'unhealthy', message: 'Connection error' },
          memory: { status: 'healthy', message: '100MB / 500MB' },
        },
      });

      const res = await app.request('/health');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('unhealthy');
    });
  });

  describe('GET /ready', () => {
    it('ready 状態の場合、200を返すべき', async () => {
      mockCheckReadiness.mockResolvedValue({
        ready: true,
        timestamp: '2024-01-01T00:00:00.000Z',
        checks: { database: true },
      });

      const res = await app.request('/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ready).toBe(true);
    });

    it('not ready 状態の場合、503を返すべき', async () => {
      mockCheckReadiness.mockResolvedValue({
        ready: false,
        timestamp: '2024-01-01T00:00:00.000Z',
        checks: { database: false },
      });

      const res = await app.request('/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ready).toBe(false);
    });
  });
});
