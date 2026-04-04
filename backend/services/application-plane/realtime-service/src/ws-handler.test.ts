import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebSocket, resetClientIdCounter } from './ws-handler';
import { RoomManager } from './room-manager';
import type { WebSocketLike, WSHandlerDeps } from './ws-handler';
import type { AuthPayload } from './auth';

function createMockWS(): WebSocketLike & {
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  sentMessages: string[];
  trigger: (event: string, ...args: unknown[]) => void;
} {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sentMessages: string[] = [];

  return {
    readyState: 1,
    listeners,
    sentMessages,
    send: vi.fn((data: string) => {
      sentMessages.push(data);
    }),
    close: vi.fn(),
    addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== listener);
      }
    }),
    trigger(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) {
        listener(...args);
      }
    },
  };
}

function createMockAuth(): AuthPayload {
  return { userId: 'user-1', tenantId: 'tenant-1', roles: ['participant'] };
}

function createDeps(): WSHandlerDeps {
  return {
    roomManager: new RoomManager(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('ws-handler', () => {
  beforeEach(() => {
    resetClientIdCounter();
  });

  describe('handleWebSocket', () => {
    it('接続時にログを出力するべき', () => {
      const ws = createMockWS();
      const deps = createDeps();
      handleWebSocket(ws, createMockAuth(), deps);
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'client_1', userId: 'user-1' }),
        expect.any(String),
      );
    });

    it('message と close のイベントリスナーを登録するべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());
      expect(ws.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(ws.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('join メッセージでルームに参加できるべき', () => {
      const ws = createMockWS();
      const deps = createDeps();
      handleWebSocket(ws, createMockAuth(), deps);

      ws.trigger('message', JSON.stringify({ action: 'join', eventId: 'event-1' }));

      expect(deps.roomManager.getRoomSize('event-1')).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent).toEqual({ type: 'joined', eventId: 'event-1' });
    });

    it('leave メッセージでルームから離脱できるべき', () => {
      const ws = createMockWS();
      const deps = createDeps();
      handleWebSocket(ws, createMockAuth(), deps);

      ws.trigger('message', JSON.stringify({ action: 'join', eventId: 'event-1' }));
      ws.trigger('message', JSON.stringify({ action: 'leave', eventId: 'event-1' }));

      expect(deps.roomManager.getRoomSize('event-1')).toBe(0);
      const sent = JSON.parse(ws.sentMessages[1]);
      expect(sent).toEqual({ type: 'left', eventId: 'event-1' });
    });

    it('ping メッセージに pong を返すべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', JSON.stringify({ action: 'ping' }));

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent).toEqual({ type: 'pong' });
    });

    it('不正なメッセージでエラーを返すべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', JSON.stringify({ action: 'invalid' }));

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.type).toBe('error');
    });

    it('不正な JSON でエラーを返すべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', 'not-json');

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.type).toBe('error');
    });

    it('close 時に全ルームからクライアントを削除するべき', () => {
      const ws = createMockWS();
      const deps = createDeps();
      handleWebSocket(ws, createMockAuth(), deps);

      ws.trigger('message', JSON.stringify({ action: 'join', eventId: 'event-1' }));
      ws.trigger('close');

      expect(deps.roomManager.getRoomSize('event-1')).toBe(0);
    });

    it('close 時にイベントリスナーを解除するべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());
      ws.trigger('close');
      expect(ws.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(ws.removeEventListener).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('readyState が 1 でない場合はメッセージを送信しないべき', () => {
      const ws = createMockWS();
      ws.readyState = 3; // CLOSED
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', JSON.stringify({ action: 'ping' }));
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('data プロパティを持つメッセージイベントを処理できるべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', { data: JSON.stringify({ action: 'ping' }) });

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent).toEqual({ type: 'pong' });
    });

    it('文字列でもオブジェクトでもないメッセージを無視するべき', () => {
      const ws = createMockWS();
      handleWebSocket(ws, createMockAuth(), createDeps());

      ws.trigger('message', 12345);
      expect(ws.sentMessages).toHaveLength(0);
    });

    it('クライアント ID が連番で採番されるべき', () => {
      const ws1 = createMockWS();
      const ws2 = createMockWS();
      const deps = createDeps();

      handleWebSocket(ws1, createMockAuth(), deps);
      handleWebSocket(ws2, createMockAuth(), deps);

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'client_1' }),
        expect.any(String),
      );
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'client_2' }),
        expect.any(String),
      );
    });
  });
});
