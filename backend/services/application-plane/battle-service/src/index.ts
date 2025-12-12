import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from './lib/logger';
import { healthRoutes } from './api/health';
import { battlesRoutes } from './api/battles';
import { authMiddleware } from './middleware/auth';

const logger = createLogger('battle-service');
const app = new Hono();

// CORS設定
app.use(
  '/*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  })
);

// バトルルートに認証を適用
app.use('/battles/*', authMiddleware);

// ルート登録
app.route('/', healthRoutes);
app.route('/', battlesRoutes);

// PORT バリデーション
const parsePort = (value: string | undefined): number => {
  const defaultPort = 3010;
  if (!value) return defaultPort;

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    logger.warn(
      { providedValue: value },
      `無効な PORT 値です。デフォルト (${defaultPort}) を使用します`
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
    logger.info({ port: info.port }, 'バトル管理サービスが起動しました');
  }
);

// グレースフルシャットダウン
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
