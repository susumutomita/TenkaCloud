import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePollingList } from "../../src/hooks/usePollingList";

/**
 * usePollingList: 一覧 polling 共有 hook。 fetcher 不在の no-op / 初回取得 / 手動 refresh /
 * hasChanged による reference 据え置き or 置換 / 省略時は毎回置換 / fetch 失敗の error 文字列化 /
 * unmount cleanup を pin する。
 */
afterEach(() => vi.clearAllMocks());

const INTERVAL = 1_000_000; // テスト中は interval を実質発火させない

describe("usePollingList", () => {
  it("should not fetch and stay null when the fetcher is null", () => {
    const { result } = renderHook(() => usePollingList<number>(null, INTERVAL));
    expect(result.current.items).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("should fetch once on mount", async () => {
    const fetcher = vi.fn().mockResolvedValue([1, 2]);
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL));
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("should re-fetch on manual refresh", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([1, 2]);
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL));
    await waitFor(() => expect(result.current.items).toEqual([1]));
    await result.current.refresh();
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("should keep the same reference when hasChanged reports no change", async () => {
    const a = [{ id: "x" }];
    const b = [{ id: "x" }]; // 別 reference だが内容同一
    const fetcher = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const hasChanged = () => false; // 「変化なし」
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL, hasChanged));
    await waitFor(() => expect(result.current.items).toBe(a));
    await result.current.refresh();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.items).toBe(a); // 据え置き (b に置換されない)
  });

  it("should replace items when hasChanged reports a change", async () => {
    const a = [{ id: "x" }];
    const b = [{ id: "y" }];
    const fetcher = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const hasChanged = () => true;
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL, hasChanged));
    await waitFor(() => expect(result.current.items).toBe(a));
    await result.current.refresh();
    await waitFor(() => expect(result.current.items).toBe(b));
  });

  it("should always replace when hasChanged is omitted", async () => {
    const a = [1];
    const b = [2];
    const fetcher = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL));
    await waitFor(() => expect(result.current.items).toBe(a));
    await result.current.refresh();
    await waitFor(() => expect(result.current.items).toBe(b));
  });

  it("should surface a fetch error as a string and reset it on success", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([9]);
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    await result.current.refresh();
    await waitFor(() => expect(result.current.items).toEqual([9]));
    expect(result.current.error).toBeNull();
  });

  it("should stringify a non-Error rejection", async () => {
    const fetcher = vi.fn().mockRejectedValue("string fail");
    const { result } = renderHook(() => usePollingList(fetcher, INTERVAL));
    await waitFor(() => expect(result.current.error).toBe("string fail"));
  });

  it("should clear the interval on unmount without throwing", () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { unmount } = renderHook(() => usePollingList(fetcher, INTERVAL));
    expect(() => unmount()).not.toThrow();
  });
});
