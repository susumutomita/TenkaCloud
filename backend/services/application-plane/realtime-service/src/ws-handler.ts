import { clientMessageSchema } from './types';
import type { ServerMessage } from './types';
import type { RoomManager, RoomClient } from './room-manager';
import type { AuthPayload } from './auth';

let clientIdCounter = 0;

/** テスト用: カウンターをリセット */
export function resetClientIdCounter() {
  clientIdCounter = 0;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

export interface WSHandlerDeps {
  roomManager: RoomManager;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

/**
 * WebSocket 接続を処理する
 * 認証済みユーザーのルーム参加・離脱・メッセージ処理を行う
 */
export function handleWebSocket(
  ws: WebSocketLike,
  auth: AuthPayload,
  deps: WSHandlerDeps,
): void {
  const { roomManager, logger } = deps;
  clientIdCounter++;
  const clientId = `client_${clientIdCounter}`;

  const sendMessage = (message: ServerMessage) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  };

  const client: RoomClient = {
    id: clientId,
    userId: auth.userId,
    tenantId: auth.tenantId,
    send: sendMessage,
  };

  logger.info({ clientId, userId: auth.userId }, 'WebSocket 接続を確立しました');

  const onMessage = (event: unknown) => {
    try {
      const rawData = typeof event === 'string' ? event : (event as { data?: string })?.data;
      if (typeof rawData !== 'string') return;

      const parsed = clientMessageSchema.safeParse(JSON.parse(rawData));
      if (!parsed.success) {
        sendMessage({ type: 'error', message: '無効なメッセージ形式です' });
        return;
      }

      const msg = parsed.data;

      switch (msg.action) {
        case 'join': {
          roomManager.join(msg.eventId, client);
          sendMessage({ type: 'joined', eventId: msg.eventId });
          logger.info({ clientId, eventId: msg.eventId }, 'ルームに参加しました');
          break;
        }
        case 'leave': {
          roomManager.leave(msg.eventId, clientId);
          sendMessage({ type: 'left', eventId: msg.eventId });
          logger.info({ clientId, eventId: msg.eventId }, 'ルームから離脱しました');
          break;
        }
        case 'ping': {
          sendMessage({ type: 'pong' });
          break;
        }
      }
    } catch {
      sendMessage({ type: 'error', message: 'メッセージの処理に失敗しました' });
    }
  };

  const onClose = () => {
    const leftRooms = roomManager.removeClient(clientId);
    logger.info({ clientId, leftRooms }, 'WebSocket 接続が切断されました');
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
  };

  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
}
