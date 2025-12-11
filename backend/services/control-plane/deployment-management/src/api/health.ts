import { Hono } from 'hono';

const healthRoutes = new Hono();

healthRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'deployment-management',
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get('/health/live', (c) => {
  return c.json({ status: 'ok' });
});

healthRoutes.get('/health/ready', (c) => {
  return c.json({ status: 'ok' });
});

export { healthRoutes };
