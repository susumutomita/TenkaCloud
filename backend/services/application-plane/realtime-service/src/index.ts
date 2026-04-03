import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import { createLogger } from './lib/logger';
import { RoomManager } from './room-manager';
import { handleWebSocket } from './ws-handler';
import { verifyToken } from './auth';
import type { RealtimeEvent } from './types';
import type { IncomingMessage } from 'node:http';

const logger = createLogger('realtime-service');
const roomManager = new RoomManager();
const app = new Hono();

// CORS設定
app.use(
  '/*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:13001'],
    credentials: true,
  })
);

// ヘルスチェック
app.get('/health', (c) => c.json({ status: 'ok', service: 'realtime-service' }));

// 内部 API: イベントをブロードキャスト（他サービスから呼ばれる）
app.post('/internal/broadcast/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  const body = (await c.req.json()) as RealtimeEvent;
  const count = roomManager.broadcast(eventId, body);
  return c.json({ broadcasted: count });
});

// ルーム統計
app.get('/internal/stats', (c) => {
  return c.json({
    totalClients: roomManager.getTotalClients(),
    rooms: roomManager.getRoomIds().map((id) => ({
      eventId: id,
      clients: roomManager.getRoomSize(id),
    })),
  });
});

// PORT バリデーション
const parsePort = (value: string | undefined): number => {
  const defaultPort = 3013;
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
    logger.info({ port: info.port }, 'リアルタイムサービスが起動しました');
  }
);

// WebSocket サーバーを HTTP サーバーに統合
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const auth = await verifyToken(token);

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleWebSocket(ws as unknown as Parameters<typeof handleWebSocket>[0], auth, {
        roomManager,
        logger,
      });
    });
  } catch (error) {
    logger.warn({ error }, 'WebSocket 認証に失敗しました');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

// グレースフルシャットダウン
const shutdown = () => {
  logger.info('シャットダウンを開始します');
  wss.close(() => {
    server.close(() => {
      logger.info('サーバーを停止しました');
      process.exit(0);
    });
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, roomManager };
