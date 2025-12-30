import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from './lib/logger';
import { rateLimitMiddleware } from './middleware/rate-limit';
import registerApp from './api/register';

const app = new Hono();
const appLogger = createLogger('registration-api');

// CORS configuration
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:13000',
      'http://localhost:13001',
      'http://localhost:13002',
      'http://localhost:13003',
      process.env.ALLOWED_ORIGIN || '',
    ].filter(Boolean),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Rate limiting for registration endpoints
app.use(
  '/api/register*',
  rateLimitMiddleware({ maxRequests: 5, windowMs: 60000 })
);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'registration' });
});

// Registration routes (public)
app.route('/api/register', registerApp);

const port = 3005;

// Only log when not in test environment
if (process.env.NODE_ENV !== 'test') {
  appLogger.info({ port }, 'Registration API is running');
}

// Graceful shutdown handlers
function gracefulShutdown(signal: string) {
  appLogger.info({ signal }, 'Received shutdown signal');
  process.exit(0);
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
