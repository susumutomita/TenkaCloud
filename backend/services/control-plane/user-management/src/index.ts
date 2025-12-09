import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from './lib/logger';
import { prisma } from './lib/prisma';
import usersApp from './api/users';

const app = new Hono();
const appLogger = createLogger('user-management-api');

// CORS configuration
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      process.env.ALLOWED_ORIGIN || '',
    ].filter(Boolean),
    credentials: true,
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'X-Tenant-Slug',
    ],
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'user-management' });
});

// User management routes
app.route('/api/users', usersApp);

const port = 3006;

// Only log when not in test environment
if (process.env.NODE_ENV !== 'test') {
  appLogger.info({ port }, 'User Management API is running');
}

// Graceful shutdown handlers
async function gracefulShutdown(signal: string) {
  appLogger.info({ signal }, 'Received shutdown signal, closing connections');

  try {
    await prisma.$disconnect();
    appLogger.info('Database connections closed');
    process.exit(0);
  } catch (error) {
    appLogger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// Only register shutdown handlers when not in test environment
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

// Export app for testing
export { app };

export default {
  port,
  fetch: app.fetch,
  hostname: '0.0.0.0',
};
