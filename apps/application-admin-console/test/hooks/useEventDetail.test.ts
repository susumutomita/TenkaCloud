import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import { useEventDetail } from "../../src/hooks/useEventDetail";

/**
 * Event 詳細取得 hook。 getEvent を mock し、 guard (= client/eventId 未確定で no-op)、
 * mount-time refresh の success・error(Error / 非 Error)、 manualRefresh の inFlight 制御 +
 * 多重実行 debounce を renderHook で pin する。
 */
const { mockGetEvent } = vi.hoisted(() => ({ mockGetEvent: vi.fn() }));
vi.mock("../../src/api/events-client", () => ({ getEvent: mockGetEvent }));

const CLIENT = {} as ApiClient;
const DETAIL = { eventId: "e1", name: "Spring Cup" };

afterEach(() => vi.clearAllMocks());

describe("useEventDetail", () => {
  it("should fetch the detail (with score events) on mount when client + eventId are valid", async () => {
    mockGetEvent.mockResolvedValue(DETAIL);
    const { result } = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    expect(result.current.detail).toEqual(DETAIL);
    expect(result.current.error).toBeNull();
    expect(mockGetEvent).toHaveBeenCalledWith(CLIENT, "e1", { withScoreEvents: true });
  });

  it("should no-op when the client is missing / eventId invalid / eventId undefined", async () => {
    for (const args of [
      { apiClient: null, eventId: "e1", eventIdValid: true },
      { apiClient: CLIENT, eventId: "e1", eventIdValid: false },
      { apiClient: CLIENT, eventId: undefined, eventIdValid: true },
    ] as const) {
      const { result } = renderHook(() => useEventDetail(args));
      // 同期的に guard を抜けるので microtask 後も detail は null。
      await act(async () => {});
      expect(result.current.detail).toBeNull();
    }
    expect(mockGetEvent).not.toHaveBeenCalled();
  });

  it("should set error.message on a fetch failure (Error) and stringify non-Error throwables", async () => {
    mockGetEvent.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );
    await waitFor(() => expect(result.current.error).toBe("boom"));

    mockGetEvent.mockRejectedValueOnce("plain-string-error");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("plain-string-error");
  });

  it("should toggle manualRefreshInFlight around a manual refresh", async () => {
    mockGetEvent.mockResolvedValue(DETAIL);
    const { result } = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );
    await waitFor(() => expect(result.current.detail).not.toBeNull());

    await act(async () => {
      await result.current.manualRefresh();
    });
    expect(result.current.manualRefreshInFlight).toBe(false);
  });

  it("should debounce a second manual refresh while one is in flight", async () => {
    let resolveGet: (v: unknown) => void = () => {};
    mockGetEvent.mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const { result } = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );

    // 1st manual refresh — getEvent は pending のままなので inFlight=true で留まる。
    act(() => {
      void result.current.manualRefresh();
    });
    await waitFor(() => expect(result.current.manualRefreshInFlight).toBe(true));
    const callsWhileInFlight = mockGetEvent.mock.calls.length;

    // 2nd manual refresh while in-flight → guard で即 return (= getEvent を呼ばない)。
    await act(async () => {
      await result.current.manualRefresh();
    });
    expect(mockGetEvent.mock.calls.length).toBe(callsWhileInFlight);

    // 1st を解決して後始末。
    await act(async () => {
      resolveGet(DETAIL);
    });
    await waitFor(() => expect(result.current.manualRefreshInFlight).toBe(false));
  });
});
