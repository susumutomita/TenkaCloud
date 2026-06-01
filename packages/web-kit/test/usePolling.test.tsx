/**
 * Issue #1418: 共有 polling primitive usePolling の regression test。
 * 即時実行 / immediate=false / enabled gate / unmount cleanup / isActive guard を pin する。
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling } from "../src/usePolling";

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should run the callback immediately and then once per interval", () => {
    const cb = vi.fn();
    renderHook(() => usePolling(cb, 1000));
    expect(cb).toHaveBeenCalledTimes(1); // immediate (= default options)
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(cb).toHaveBeenCalledTimes(4); // 1 immediate + 3 ticks
  });

  it("should skip the immediate run when immediate is false", () => {
    const cb = vi.fn();
    renderHook(() => usePolling(cb, 1000, { immediate: false }));
    expect(cb).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(cb).toHaveBeenCalledTimes(1); // first tick only after the interval elapses
  });

  it("should not poll while enabled is false", () => {
    const cb = vi.fn();
    renderHook(() => usePolling(cb, 1000, { enabled: false }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("should start polling when enabled flips from false to true", () => {
    const cb = vi.fn();
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => usePolling(cb, 1000, { enabled: on }),
      {
        initialProps: { on: false },
      },
    );
    expect(cb).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(cb).toHaveBeenCalledTimes(1); // immediate run once enabled
  });

  it("should stop polling after unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => usePolling(cb, 1000));
    expect(cb).toHaveBeenCalledTimes(1);
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(cb).toHaveBeenCalledTimes(1); // no further ticks after cleanup
  });

  it("should report isActive true while mounted and false after unmount", () => {
    let captured: (() => boolean) | null = null;
    const cb = vi.fn((isActive: () => boolean) => {
      captured = isActive;
    });
    const { unmount } = renderHook(() => usePolling(cb, 1000));
    // biome-ignore lint/style/noNonNullAssertion: immediate run guarantees captured is set
    expect(captured!()).toBe(true);
    unmount();
    // biome-ignore lint/style/noNonNullAssertion: captured was set during the immediate run
    expect(captured!()).toBe(false); // stale async tick can detect unmount and bail
  });
});
