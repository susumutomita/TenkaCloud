import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from './lib/logger';
import { healthRoutes } from './api/health';
import { adminRoutes } from './api/admin';
import { participantRoutes } from './api/participant';
import { authMiddleware, requireAdmin } from './middleware/auth';
import { auditorService } from './services/auditor-service';
import { getAllowedOrigins } from './lib/cors';

const logger = createLogger('gameday-service');
const app = new Hono();

// CORS設定
app.use(
  '/*',
  cors({
    origin: getAllowedOrigins(process.env.CORS_ORIGIN),
    credentials: true,
  })
);

// 認証を適用
app.use('/api/gameday/*', authMiddleware);
app.use('/api/gameday/admin/*', requireAdmin);

// ルート登録
app.route('/', healthRoutes);
app.route('/api/gameday/admin', adminRoutes);
app.route('/api/gameday', participantRoutes);

// PORT バリデーション
const parsePort = (value: string | undefined): number => {
  const defaultPort = 3020;
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
    logger.info({ port: info.port }, 'GameDay サービスが起動しました');
  }
);

// グレースフルシャットダウン
const shutdown = () => {
  logger.info('シャットダウンを開始します');
  auditorService.stop();
  server.close(() => {
    logger.info('サーバーを停止しました');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app };
