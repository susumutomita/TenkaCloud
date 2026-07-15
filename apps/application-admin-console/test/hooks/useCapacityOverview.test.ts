import { act, renderHook, waitFor } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityOverview } from "../../src/api/capacity-client";
import { type ApiClient, ApiError } from "../../src/api/client";

/**
 * Issue #2410 Slice 2: useCapacityOverview — 30 秒 polling + terminal エラーでの polling 停止
 * (403 / 503 / 501) + ページ非表示ゲート + unmount 後の stale setState ガード。
 */
const mocks = vi.hoisted(() => ({
  getCapacityOverview: vi.fn(),
}));

vi.mock("../../src/api/capacity-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/capacity-client")>();
  return { ...actual, getCapacityOverview: mocks.getCapacityOverview };
});

const { useCapacityOverview, usePageVisible } = await import("../../src/hooks/useCapacityOverview");
const { DEPLOYMENT_POLL_INTERVAL_MS } = await import("../../src/constants/polling");

const apiClient = {} as unknown as ApiClient;

const overview: CapacityOverview = {
  windowMinutes: 30,
  ceiling: 200,
  runbookDocumentName: "stack-event-capacity",
  generatedAt: "2026-07-07T12:00:00.000Z",
  tables: [],
};

function setVisibilityState(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setVisibilityState("visible");
  vi.useRealTimers();
});

describe("useCapacityOverview", () => {
  it("should fetch immediately and expose the overview", async () => {
    mocks.getCapacityOverview.mockResolvedValue(overview);

    const { result } = renderHook(() => useCapacityOverview(apiClient));

    await waitFor(() => expect(result.current.overview).toEqual(overview));
    expect(result.current.error).toBeNull();
    expect(result.current.terminalReason).toBeNull();
  });

  it("should keep polling on the interval while healthy", async () => {
    vi.useFakeTimers();
    mocks.getCapacityOverview.mockResolvedValue(overview);

    renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(DEPLOYMENT_POLL_INTERVAL_MS);
    });
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(2);
  });

  it("should never fetch without an api client", async () => {
    const { result } = renderHook(() => useCapacityOverview(null));

    await act(async () => {});
    expect(mocks.getCapacityOverview).not.toHaveBeenCalled();
    expect(result.current.overview).toBeNull();
  });

  it("should treat a non-terminal ApiError (e.g. 500) as transient, not terminal", async () => {
    mocks.getCapacityOverview.mockRejectedValue(
      new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, "boom"),
    );

    const { result } = renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});

    expect(result.current.terminalReason).toBeNull();
    expect(result.current.error).toContain("500");
  });

  it("should surface a transient error message and keep polling", async () => {
    vi.useFakeTimers();
    mocks.getCapacityOverview.mockRejectedValue(new Error("cloudwatch boom"));

    const { result } = renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});

    expect(result.current.error).toContain("cloudwatch boom");
    expect(result.current.terminalReason).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(DEPLOYMENT_POLL_INTERVAL_MS);
    });
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(2);
  });

  it.each([
    [StatusCodes.FORBIDDEN, "forbidden"],
    [StatusCodes.SERVICE_UNAVAILABLE, "unavailable"],
    [StatusCodes.NOT_IMPLEMENTED, "unsupported"],
    // Issue #2648: 純 SQL backend は容量監視非該当 → route が 404 → not_applicable で polling 停止。
    [StatusCodes.NOT_FOUND, "not_applicable"],
  ] as const)("should stop polling on terminal status %s and expose reason %s", async (status, reason) => {
    vi.useFakeTimers();
    mocks.getCapacityOverview.mockRejectedValue(new ApiError(status, "nope"));

    const { result } = renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});

    expect(result.current.terminalReason).toBe(reason);
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1);

    // terminal: interval が進んでも再 fetch しない (= 無駄な有料 poll を出さない)。
    await act(async () => {
      vi.advanceTimersByTime(DEPLOYMENT_POLL_INTERVAL_MS * 3);
    });
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1);
  });

  it("should recover from a terminal state via manual refresh and re-arm polling", async () => {
    mocks.getCapacityOverview
      .mockRejectedValueOnce(new ApiError(StatusCodes.SERVICE_UNAVAILABLE, "unwired"))
      .mockResolvedValue(overview);

    const { result } = renderHook(() => useCapacityOverview(apiClient));
    await waitFor(() => expect(result.current.terminalReason).toBe("unavailable"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.terminalReason).toBeNull();
    expect(result.current.overview).toEqual(overview);
    expect(result.current.error).toBeNull();
  });

  it("should surface a manual-refresh failure too (isActive absent on manual calls)", async () => {
    mocks.getCapacityOverview
      .mockResolvedValueOnce(overview)
      .mockRejectedValueOnce(new Error("flaky"));

    const { result } = renderHook(() => useCapacityOverview(apiClient));
    await waitFor(() => expect(result.current.overview).toEqual(overview));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toContain("flaky");
  });

  it("should not poll while the page is hidden and resume on visibility", async () => {
    vi.useFakeTimers();
    mocks.getCapacityOverview.mockResolvedValue(overview);

    renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibilityState("hidden");
    });
    await act(async () => {
      vi.advanceTimersByTime(DEPLOYMENT_POLL_INTERVAL_MS * 3);
    });
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(1);

    // 再表示で即 fetch (usePolling immediate) → polling 再開。
    await act(async () => {
      setVisibilityState("visible");
    });
    expect(mocks.getCapacityOverview).toHaveBeenCalledTimes(2);
  });

  it("should drop a stale success resolving after unmount (isActive guard)", async () => {
    let resolveFetch: (value: CapacityOverview) => void = () => {};
    mocks.getCapacityOverview.mockImplementation(
      () =>
        new Promise<CapacityOverview>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { unmount } = renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});
    unmount();

    // unmount 後に解決しても setState されない (act 警告 / メモリリークなし)。
    await act(async () => {
      resolveFetch(overview);
    });
  });

  it("should drop a stale failure rejecting after unmount (isActive guard)", async () => {
    let rejectFetch: (err: unknown) => void = () => {};
    mocks.getCapacityOverview.mockImplementation(
      () =>
        new Promise<CapacityOverview>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );

    const { unmount } = renderHook(() => useCapacityOverview(apiClient));
    await act(async () => {});
    unmount();

    await act(async () => {
      rejectFetch(new Error("late"));
    });
  });
});

describe("usePageVisible", () => {
  it("should track document visibility changes", async () => {
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toBe(true);

    await act(async () => {
      setVisibilityState("hidden");
    });
    expect(result.current).toBe(false);

    await act(async () => {
      setVisibilityState("visible");
    });
    expect(result.current).toBe(true);
  });
});
