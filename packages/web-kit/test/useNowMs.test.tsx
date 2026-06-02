/**
 * useNowMs (web-kit clock hook) の regression test。
 * 初期値 = mount 時刻 / interval ごとの更新 / immediate を打たないこと / unmount cleanup を pin する。
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNowMs } from "../src/useNowMs";

describe("useNowMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return the mount time initially without an immediate extra tick", () => {
    const start = Date.now();
    const { result } = renderHook(() => useNowMs(1000));
    expect(result.current).toBe(start);
  });

  it("should advance the returned time once per interval", () => {
    const start = Date.now();
    const { result } = renderHook(() => useNowMs(1000));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(start + 1000);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(start + 3000);
  });

  it("should stop updating after unmount", () => {
    const start = Date.now();
    const { result, unmount } = renderHook(() => useNowMs(1000));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(start + 1000);
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(start + 1000); // frozen at last value, no further ticks
  });
});
