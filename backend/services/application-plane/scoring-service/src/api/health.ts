import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'scoring-service' });
});

healthRoutes.get('/ready', async (c) => {
  return c.json({ status: 'ready' });
});
