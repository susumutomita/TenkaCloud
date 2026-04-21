import { app } from './app';
import { createLogger } from './lib/logger';

const appLogger = createLogger('tenant-api');

const port = Number.parseInt(process.env.PORT ?? '13004', 10);

if (process.env.NODE_ENV !== 'test') {
  appLogger.info({ port }, 'Tenant Management API is running');
}

function gracefulShutdown(signal: string) {
  appLogger.info({ signal }, 'Received shutdown signal');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

export { app };

export default {
  port,
  fetch: app.fetch,
};
