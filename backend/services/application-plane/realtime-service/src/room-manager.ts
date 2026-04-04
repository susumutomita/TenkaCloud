import type { ServerMessage } from './types';

export interface RoomClient {
  id: string;
  userId: string;
  tenantId: string;
  send: (message: ServerMessage) => void;
}

/**
 * イベント ID ごとのルーム管理
 * クライアントの参加・離脱・ブロードキャストを管理する
 */
export class RoomManager {
  private rooms = new Map<string, Map<string, RoomClient>>();

  /** ルームに参加 */
  join(eventId: string, client: RoomClient): void {
    let room = this.rooms.get(eventId);
    if (!room) {
      room = new Map();
      this.rooms.set(eventId, room);
    }
    room.set(client.id, client);
  }

  /** ルームから離脱 */
  leave(eventId: string, clientId: string): void {
    const room = this.rooms.get(eventId);
    if (!room) return;
    room.delete(clientId);
    if (room.size === 0) {
      this.rooms.delete(eventId);
    }
  }

  /** クライアントを全ルームから削除 */
  removeClient(clientId: string): string[] {
    const leftRooms: string[] = [];
    for (const [eventId, room] of this.rooms) {
      if (room.has(clientId)) {
        room.delete(clientId);
        leftRooms.push(eventId);
        if (room.size === 0) {
          this.rooms.delete(eventId);
        }
      }
    }
    return leftRooms;
  }

  /** ルーム内の全クライアントにメッセージを送信 */
  broadcast(eventId: string, message: ServerMessage): number {
    const room = this.rooms.get(eventId);
    if (!room) return 0;
    let count = 0;
    for (const client of room.values()) {
      client.send(message);
      count++;
    }
    return count;
  }

  /** 特定のルームのクライアント数を取得 */
  getRoomSize(eventId: string): number {
    return this.rooms.get(eventId)?.size ?? 0;
  }

  /** 全ルームのイベント ID を取得 */
  getRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  /** 全ルームの合計クライアント数を取得 */
  getTotalClients(): number {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.size;
    }
    return total;
  }
}
