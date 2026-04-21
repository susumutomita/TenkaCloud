import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIntervalPolling } from '../use-interval-polling';

describe('useIntervalPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('マウント直後に fetcher を 1 回呼び出し data をセットすべき', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { result } = renderHook(() => useIntervalPolling(fetcher));

    await vi.waitFor(() => {
      expect(result.current.data).toEqual({ value: 1 });
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('interval ごとに再フェッチすべき', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ value: 1 })
      .mockResolvedValueOnce({ value: 2 });

    const { result } = renderHook(() =>
      useIntervalPolling(fetcher, { intervalMs: 1000 }),
    );

    await vi.waitFor(() => expect(result.current.data).toEqual({ value: 1 }));

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await vi.waitFor(() => expect(result.current.data).toEqual({ value: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('同一内容が返ってきたら setState をスキップすべき (reference 同一)', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { result } = renderHook(() =>
      useIntervalPolling(fetcher, { intervalMs: 1000 }),
    );

    await vi.waitFor(() => expect(result.current.data).toEqual({ value: 1 }));
    const firstRef = result.current.data;

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(result.current.data).toBe(firstRef);
  });

  it('fetcher が reject したら error と connected=false をセットすべき', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useIntervalPolling(fetcher));

    await vi.waitFor(() => {
      expect(result.current.error).toBe('boom');
    });
    expect(result.current.connected).toBe(false);
  });

  it('Error でない throw でも文字列化して error をセットすべき', async () => {
    const fetcher = vi.fn().mockRejectedValue('plain');
    const { result } = renderHook(() => useIntervalPolling(fetcher));

    await vi.waitFor(() => {
      expect(result.current.error).toBe('plain');
    });
  });

  it('enabled=false の間は fetcher を呼ばないべき', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    renderHook(() =>
      useIntervalPolling(fetcher, { enabled: false, intervalMs: 500 }),
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('unmount 後に遅れて resolve した fetch は state を更新しないべき', async () => {
    let resolve: (v: { value: number }) => void = () => {};
    const fetcher = vi.fn(
      () => new Promise<{ value: number }>((r) => (resolve = r)),
    );
    const { result, unmount } = renderHook(() => useIntervalPolling(fetcher));

    unmount();
    await act(async () => {
      resolve({ value: 99 });
    });

    // data should stay null since the cancel flag was set
    expect(result.current.data).toBeNull();
  });

  it('unmount 時に interval を clear すべき', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const { unmount } = renderHook(() =>
      useIntervalPolling(fetcher, { intervalMs: 500 }),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetcher を差し替えても interval は再生成されないべき', async () => {
    const a = vi.fn().mockResolvedValue({ id: 'a' });
    const b = vi.fn().mockResolvedValue({ id: 'b' });

    const { result, rerender } = renderHook(
      ({ f }) => useIntervalPolling(f, { intervalMs: 1000 }),
      { initialProps: { f: a } },
    );

    await vi.waitFor(() => expect(result.current.data).toEqual({ id: 'a' }));

    rerender({ f: b });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await vi.waitFor(() => expect(result.current.data).toEqual({ id: 'b' }));
  });
});
