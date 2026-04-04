import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoomManager } from './room-manager';
import type { RoomClient } from './room-manager';

function createMockClient(id: string): RoomClient {
  return {
    id,
    userId: `user-${id}`,
    tenantId: `tenant-${id}`,
    send: vi.fn(),
  };
}

describe('RoomManager', () => {
  let manager: RoomManager;

  beforeEach(() => {
    manager = new RoomManager();
  });

  describe('join', () => {
    it('クライアントをルームに追加できるべき', () => {
      const client = createMockClient('c1');
      manager.join('event-1', client);
      expect(manager.getRoomSize('event-1')).toBe(1);
    });

    it('同じルームに複数クライアントを追加できるべき', () => {
      manager.join('event-1', createMockClient('c1'));
      manager.join('event-1', createMockClient('c2'));
      expect(manager.getRoomSize('event-1')).toBe(2);
    });

    it('同じクライアントを再追加しても重複しないべき', () => {
      const client = createMockClient('c1');
      manager.join('event-1', client);
      manager.join('event-1', client);
      expect(manager.getRoomSize('event-1')).toBe(1);
    });
  });

  describe('leave', () => {
    it('クライアントをルームから削除できるべき', () => {
      const client = createMockClient('c1');
      manager.join('event-1', client);
      manager.leave('event-1', 'c1');
      expect(manager.getRoomSize('event-1')).toBe(0);
    });

    it('空になったルームを自動削除するべき', () => {
      const client = createMockClient('c1');
      manager.join('event-1', client);
      manager.leave('event-1', 'c1');
      expect(manager.getRoomIds()).not.toContain('event-1');
    });

    it('存在しないルームから離脱してもエラーにならないべき', () => {
      expect(() => manager.leave('nonexistent', 'c1')).not.toThrow();
    });

    it('存在しないクライアントを削除してもエラーにならないべき', () => {
      manager.join('event-1', createMockClient('c1'));
      expect(() => manager.leave('event-1', 'c999')).not.toThrow();
      expect(manager.getRoomSize('event-1')).toBe(1);
    });
  });

  describe('removeClient', () => {
    it('クライアントを全ルームから削除できるべき', () => {
      const client = createMockClient('c1');
      manager.join('event-1', client);
      manager.join('event-2', client);
      const leftRooms = manager.removeClient('c1');
      expect(leftRooms).toEqual(expect.arrayContaining(['event-1', 'event-2']));
      expect(manager.getRoomSize('event-1')).toBe(0);
      expect(manager.getRoomSize('event-2')).toBe(0);
    });

    it('存在しないクライアントの削除で空配列を返すべき', () => {
      expect(manager.removeClient('nonexistent')).toEqual([]);
    });

    it('他のクライアントに影響しないべき', () => {
      manager.join('event-1', createMockClient('c1'));
      manager.join('event-1', createMockClient('c2'));
      manager.removeClient('c1');
      expect(manager.getRoomSize('event-1')).toBe(1);
    });
  });

  describe('broadcast', () => {
    it('ルーム内の全クライアントにメッセージを送信するべき', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      manager.join('event-1', c1);
      manager.join('event-1', c2);

      const message = { type: 'score_update' as const, teamId: 'team-1', score: 100, rank: 1 };
      const count = manager.broadcast('event-1', message);

      expect(count).toBe(2);
      expect(c1.send).toHaveBeenCalledWith(message);
      expect(c2.send).toHaveBeenCalledWith(message);
    });

    it('存在しないルームへのブロードキャストで 0 を返すべき', () => {
      expect(manager.broadcast('nonexistent', { type: 'pong' })).toBe(0);
    });

    it('他のルームのクライアントにはメッセージを送信しないべき', () => {
      const c1 = createMockClient('c1');
      const c2 = createMockClient('c2');
      manager.join('event-1', c1);
      manager.join('event-2', c2);

      manager.broadcast('event-1', { type: 'pong' });

      expect(c1.send).toHaveBeenCalled();
      expect(c2.send).not.toHaveBeenCalled();
    });
  });

  describe('getRoomSize', () => {
    it('存在しないルームのサイズは 0 を返すべき', () => {
      expect(manager.getRoomSize('nonexistent')).toBe(0);
    });
  });

  describe('getRoomIds', () => {
    it('全ルームの ID を返すべき', () => {
      manager.join('event-1', createMockClient('c1'));
      manager.join('event-2', createMockClient('c2'));
      expect(manager.getRoomIds()).toEqual(expect.arrayContaining(['event-1', 'event-2']));
    });

    it('ルームがない場合は空配列を返すべき', () => {
      expect(manager.getRoomIds()).toEqual([]);
    });
  });

  describe('getTotalClients', () => {
    it('全ルームの合計クライアント数を返すべき', () => {
      manager.join('event-1', createMockClient('c1'));
      manager.join('event-1', createMockClient('c2'));
      manager.join('event-2', createMockClient('c3'));
      expect(manager.getTotalClients()).toBe(3);
    });

    it('クライアントがいない場合は 0 を返すべき', () => {
      expect(manager.getTotalClients()).toBe(0);
    });
  });
});
