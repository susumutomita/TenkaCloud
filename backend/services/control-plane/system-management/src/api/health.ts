import { Hono } from 'hono';
import { HealthService } from '../services/health';

const healthRoutes = new Hono();
const healthService = new HealthService();

healthRoutes.get('/health', async (c) => {
  const health = await healthService.checkHealth();
  const statusCode = health.status === 'healthy' ? 200 : 503;
  return c.json(health, statusCode);
});

healthRoutes.get('/ready', async (c) => {
  const readiness = await healthService.checkReadiness();
  const statusCode = readiness.ready ? 200 : 503;
  return c.json(readiness, statusCode);
});

export { healthRoutes };
