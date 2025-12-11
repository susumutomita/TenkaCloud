import { Hono } from 'hono';
import { MetricsService } from '../services/metrics';

const metricsRoutes = new Hono();
const metricsService = new MetricsService();

metricsRoutes.get('/metrics', async (c) => {
  const metrics = await metricsService.collectMetrics();
  return c.json(metrics);
});

export { metricsRoutes };
