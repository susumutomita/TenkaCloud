import { serve } from '@hono/node-server';
import { app } from './app';
import { createLogger } from './lib/logger';

const logger = createLogger('scoring-service');

const parsePort = (value: string | undefined): number => {
  const defaultPort = 3011;
  if (!value) return defaultPort;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    logger.warn(
      { providedValue: value },
      `無効な PORT 値です。デフォルト (${defaultPort}) を使用します`,
    );
    return defaultPort;
  }
  return parsed;
};

const port = parsePort(process.env.PORT);

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    logger.info({ port: info.port }, '採点サービスが起動しました');
  },
);

const shutdown = () => {
  logger.info('シャットダウンを開始します');
  server.close(() => {
    logger.info('サーバーを停止しました');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app };
