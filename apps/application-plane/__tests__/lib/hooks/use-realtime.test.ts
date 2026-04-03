import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtime } from '@/lib/hooks/use-realtime';
import type { RealtimeEvent } from '@/lib/hooks/use-realtime';

// --- WebSocket モック ---

type WSListener = (event: { data: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(
        (l) => l !== listener,
      );
    }
  }

  send = vi.fn();
  close = vi.fn();

  // テスト用ヘルパー
  simulateOpen() {
    for (const listener of this.listeners['open'] ?? []) {
      listener();
    }
  }

  simulateMessage(data: unknown) {
    for (const listener of this.listeners['message'] ?? []) {
      (listener as WSListener)({ data: JSON.stringify(data) });
    }
  }

  simulateClose() {
    for (const listener of this.listeners['close'] ?? []) {
      listener();
    }
  }

  simulateError() {
    for (const listener of this.listeners['error'] ?? []) {
      listener();
    }
  }
}

describe('useRealtime', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  it('eventId と token が未指定の場合接続しないべき', () => {
    renderHook(() => useRealtime(undefined, undefined));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('eventId のみ指定で token がない場合接続しないべき', () => {
    renderHook(() => useRealtime('event-1', undefined));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('token のみ指定で eventId がない場合接続しないべき', () => {
    renderHook(() => useRealtime(undefined, 'token-1'));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('eventId と token が指定された場合 WebSocket 接続を開始するべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('token=jwt-token');
    expect(MockWebSocket.instances[0].url).toContain('eventId=event-1');
  });

  it('接続成功時に isConnected が true になるべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    expect(result.current.isConnected).toBe(false);

    act(() => {
      MockWebSocket.instances[0].simulateOpen();
    });

    expect(result.current.isConnected).toBe(true);
  });

  it('接続成功時にルーム参加メッセージを送信するべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ action: 'join', eventId: 'event-1' }),
    );
  });

  it('30秒ごとにハートビートを送信するべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    // 初回の join メッセージ
    expect(ws.send).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ action: 'ping' }));
  });

  it('readyState が OPEN でない場合ハートビートを送信しないべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    ws.readyState = MockWebSocket.CLOSED;

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    // join のみで ping は送信されない
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('リアルタイムイベントを受信して lastEvent を更新するべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    const event: RealtimeEvent = {
      type: 'score_update',
      teamId: 'team-1',
      score: 100,
      rank: 1,
    };

    act(() => {
      ws.simulateMessage(event);
    });

    expect(result.current.lastEvent).toEqual(event);
  });

  it('subscribe で登録したコールバックがイベント受信時に呼ばれるべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];
    const callback = vi.fn();

    act(() => {
      ws.simulateOpen();
      result.current.subscribe(callback);
    });

    const event: RealtimeEvent = {
      type: 'score_update',
      teamId: 'team-1',
      score: 50,
      rank: 2,
    };

    act(() => {
      ws.simulateMessage(event);
    });

    expect(callback).toHaveBeenCalledWith(event);
  });

  it('unsubscribe 後はコールバックが呼ばれないべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];
    const callback = vi.fn();
    let unsubscribe: () => void;

    act(() => {
      ws.simulateOpen();
      unsubscribe = result.current.subscribe(callback);
    });

    act(() => {
      unsubscribe();
    });

    act(() => {
      ws.simulateMessage({
        type: 'score_update',
        teamId: 'team-1',
        score: 50,
        rank: 2,
      });
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('pong メッセージは lastEvent に設定されないべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({ type: 'pong' });
    });

    expect(result.current.lastEvent).toBeNull();
  });

  it('不正な JSON メッセージでエラーにならないべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    // simulateMessage は JSON.stringify するので直接リスナーを呼ぶ
    expect(() => {
      act(() => {
        for (const listener of (
          ws as unknown as {
            listeners: Record<string, ((...args: unknown[]) => void)[]>;
          }
        ).listeners['message'] ?? []) {
          (listener as (event: { data: string }) => void)({
            data: 'not-json',
          });
        }
      });
    }).not.toThrow();
  });

  it('切断時に指数バックオフで再接続するべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateClose();
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    // 1秒後に再接続
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('再接続成功時にバックオフがリセットされるべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));

    // 最初の接続 → 切断
    act(() => {
      MockWebSocket.instances[0].simulateOpen();
      MockWebSocket.instances[0].simulateClose();
    });

    // 1秒後に再接続
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // 再接続成功
    act(() => {
      MockWebSocket.instances[1].simulateOpen();
    });

    // 再度切断
    act(() => {
      MockWebSocket.instances[1].simulateClose();
    });

    // バックオフがリセットされたので再度 1秒で再接続
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('バックオフが最大 30 秒を超えないべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));

    // 繰り返し切断して指数バックオフを最大まで上げる
    for (let i = 0; i < 10; i++) {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => {
        ws.simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
    }

    // 10回再接続しても全インスタンスが作成されるはず (最初の1 + 再接続10)
    expect(MockWebSocket.instances.length).toBe(11);
  });

  it('アンマウント時に WebSocket を閉じるべき', () => {
    const { unmount } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    unmount();

    expect(ws.close).toHaveBeenCalled();
  });

  it('アンマウント後は再接続しないべき', () => {
    const { unmount } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    unmount();

    act(() => {
      ws.simulateClose();
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    // 最初の1つだけ
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('アンマウント後に open イベントが発火しても状態を更新しないべき', () => {
    const { result, unmount } = renderHook(() =>
      useRealtime('event-1', 'jwt-token'),
    );
    const ws = MockWebSocket.instances[0];

    unmount();

    act(() => {
      ws.simulateOpen();
    });

    // isConnected は false のまま
    expect(result.current.isConnected).toBe(false);
  });

  it('アンマウント後に message イベントが発火しても状態を更新しないべき', () => {
    const { result, unmount } = renderHook(() =>
      useRealtime('event-1', 'jwt-token'),
    );
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.simulateOpen();
    });

    unmount();

    act(() => {
      ws.simulateMessage({
        type: 'score_update',
        teamId: 't1',
        score: 100,
        rank: 1,
      });
    });

    // unmount 後は lastEvent は更新されない
    expect(result.current.lastEvent).toBeNull();
  });

  it('アンマウント後に close イベントが発火しても再接続しないべき', () => {
    const { unmount } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    unmount();

    act(() => {
      ws.simulateClose();
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('error イベントでクラッシュしないべき', () => {
    renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];

    expect(() => {
      act(() => {
        ws.simulateError();
      });
    }).not.toThrow();
  });

  it('全リアルタイムイベントタイプを subscriber に通知するべき', () => {
    const { result } = renderHook(() => useRealtime('event-1', 'jwt-token'));
    const ws = MockWebSocket.instances[0];
    const callback = vi.fn();

    act(() => {
      ws.simulateOpen();
      result.current.subscribe(callback);
    });

    const events: RealtimeEvent[] = [
      { type: 'score_update', teamId: 't1', score: 100, rank: 1 },
      {
        type: 'attack_executed',
        attackerTeamId: 'a',
        defenderTeamId: 'b',
        attackSlug: 'cpu',
      },
      {
        type: 'game_state_changed',
        isRunning: true,
        scoreWeight: '1.0',
        blackout: false,
      },
      { type: 'leaderboard_update', entries: [] },
    ];

    for (const event of events) {
      act(() => {
        ws.simulateMessage(event);
      });
    }

    expect(callback).toHaveBeenCalledTimes(4);
  });
});
