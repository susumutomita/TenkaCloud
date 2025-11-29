/**
 * API ルーター
 *
 * 管理画面と競技者画面を分離
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { adminRouter } from './admin';
import { playerRouter } from './player';
import { participantRouter } from './participant';

const app = new Hono();

// ミドルウェア
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:3000', // Admin App
      'http://localhost:3001', // Participant App
      'http://localhost:3002', // Landing Page
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'AuthorizationToken'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
  })
);

// ヘルスチェック
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'problem-management',
    timestamp: new Date().toISOString(),
  });
});

// API バージョン情報
app.get('/api/version', (c) => {
  return c.json({
    version: '1.0.0',
    name: 'TenkaCloud Problem Management API',
    endpoints: {
      admin: '/api/admin',
      player: '/api/player',
      participant: '/api/participant',
    },
  });
});

// ルーターをマウント
// 管理画面API: /api/admin/*
app.route('/api/admin', adminRouter);

// 競技者画面API: /api/player/*
app.route('/api/player', playerRouter);

// 参加者API: /api/participant/*
app.route('/api/participant', participantRouter);

// 404 ハンドラー
app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      message: `Path ${c.req.path} not found`,
    },
    404
  );
});

// エラーハンドラー
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    },
    500
  );
});

export { app };
export default app;
