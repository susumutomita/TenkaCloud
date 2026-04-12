import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationProvider, useNotifications } from '../context';
import { createLocalStorageMock } from '../../__tests__/test-helpers';

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NotificationProvider>{children}</NotificationProvider>;
  };
}

describe('NotificationProvider', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: createLocalStorageMock(),
    });
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('初期状態で通知が空であるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('通知を追加できるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'attack_received',
        title: '攻撃を受けています',
        message: 'チームAから攻撃を受けました',
        severity: 'error',
      });
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].title).toBe('攻撃を受けています');
    expect(result.current.notifications[0].message).toBe(
      'チームAから攻撃を受けました',
    );
    expect(result.current.notifications[0].type).toBe('attack_received');
    expect(result.current.notifications[0].severity).toBe('error');
    expect(result.current.notifications[0].read).toBe(false);
    expect(result.current.notifications[0].id).toBeDefined();
    expect(result.current.notifications[0].timestamp).toBeDefined();
  });

  it('未読数を正しく計算すべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'game_started',
        title: 'ゲーム開始',
        message: 'GameDayが開始されました',
        severity: 'success',
      });
      result.current.addNotification({
        type: 'alliance_request',
        title: '同盟リクエスト',
        message: 'リクエストが届きました',
        severity: 'info',
      });
    });

    expect(result.current.unreadCount).toBe(2);
  });

  it('個別の通知を既読にできるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'game_started',
        title: 'ゲーム開始',
        message: 'GameDayが開始されました',
        severity: 'success',
      });
      result.current.addNotification({
        type: 'game_stopped',
        title: 'ゲーム停止',
        message: 'GameDayが停止されました',
        severity: 'warning',
      });
    });

    const firstId = result.current.notifications[0].id;

    act(() => {
      result.current.markAsRead(firstId);
    });

    expect(result.current.notifications[0].read).toBe(true);
    expect(result.current.notifications[1].read).toBe(false);
    expect(result.current.unreadCount).toBe(1);
  });

  it('すべての通知を既読にできるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'game_started',
        title: '通知1',
        message: 'メッセージ1',
        severity: 'info',
      });
      result.current.addNotification({
        type: 'game_stopped',
        title: '通知2',
        message: 'メッセージ2',
        severity: 'warning',
      });
    });

    act(() => {
      result.current.markAllRead();
    });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
  });

  it('すべての通知をクリアできるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'general',
        title: '通知',
        message: 'メッセージ',
        severity: 'info',
      });
    });

    expect(result.current.notifications).toHaveLength(1);

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
  });

  it('新しい通知が先頭に追加されるべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'game_started',
        title: '最初の通知',
        message: '最初',
        severity: 'info',
      });
    });

    act(() => {
      result.current.addNotification({
        type: 'game_stopped',
        title: '2番目の通知',
        message: '2番目',
        severity: 'warning',
      });
    });

    expect(result.current.notifications[0].title).toBe('2番目の通知');
    expect(result.current.notifications[1].title).toBe('最初の通知');
  });

  it('localStorageに永続化されるべき', async () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'score_weight_changed',
        title: 'スコア倍率変更',
        message: 'スコア倍率がhighに変更されました',
        severity: 'info',
      });
    });

    // Wait for useEffect to persist
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const stored = window.localStorage.getItem('tenkacloud-notifications');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('スコア倍率変更');
  });

  it('localStorageから復元できるべき', () => {
    const existingNotifications = [
      {
        id: 'test-1',
        type: 'general',
        title: '保存済み通知',
        message: 'localStorageから復元',
        timestamp: '2026-01-01T00:00:00.000Z',
        read: false,
        severity: 'info',
      },
    ];
    window.localStorage.setItem(
      'tenkacloud-notifications',
      JSON.stringify(existingNotifications),
    );

    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].title).toBe('保存済み通知');
    expect(result.current.unreadCount).toBe(1);
  });

  it('localStorageの不正なデータを安全に処理すべき', () => {
    window.localStorage.setItem('tenkacloud-notifications', 'invalid json');

    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    expect(result.current.notifications).toEqual([]);
  });

  it('localStorageが配列以外の場合に空配列を返すべき', () => {
    window.localStorage.setItem(
      'tenkacloud-notifications',
      JSON.stringify({ not: 'an array' }),
    );

    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    expect(result.current.notifications).toEqual([]);
  });

  it('Provider外でuseNotificationsを使うとエラーをスローすべき', () => {
    expect(() => {
      renderHook(() => useNotifications());
    }).toThrow('useNotifications must be used within NotificationProvider');
  });

  it('存在しないIDでmarkAsReadを呼んでもエラーにならないべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'general',
        title: '通知',
        message: 'メッセージ',
        severity: 'info',
      });
    });

    act(() => {
      result.current.markAsRead('non-existent-id');
    });

    expect(result.current.notifications[0].read).toBe(false);
  });

  it('空の状態でmarkAllReadを呼んでもエラーにならないべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllRead();
    });

    expect(result.current.notifications).toEqual([]);
  });

  it('空の状態でclearAllを呼んでもエラーにならないべき', () => {
    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.notifications).toEqual([]);
  });

  it('localStorage書き込みが失敗しても安全に処理すべき', async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.addNotification({
        type: 'general',
        title: '通知',
        message: 'メッセージ',
        severity: 'info',
      });
    });

    // Should not throw
    expect(result.current.notifications).toHaveLength(1);
    setItemSpy.mockRestore();
  });
});
