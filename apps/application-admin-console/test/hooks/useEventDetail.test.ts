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

  it("should request stored team login keys for a mutating operator", async () => {
    mockGetEvent.mockResolvedValue(DETAIL);
    renderHook(() =>
      useEventDetail({
        apiClient: CLIENT,
        eventId: "e1",
        eventIdValid: true,
        withTeamLoginKeys: true,
      }),
    );
    await waitFor(() => expect(mockGetEvent).toHaveBeenCalled());
    expect(mockGetEvent).toHaveBeenCalledWith(CLIENT, "e1", {
      withScoreEvents: true,
      withTeamLoginKeys: true,
    });
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

/**
 * 進行中イベントの自動更新 (Issue 2987)。
 *
 * この画面は「ライブイベント中に開きっぱなしで監視する」のが最も典型的な使い方で、
 * mount 時 1 回だけ取得する実装では、参加者が提出してスコアが動いても運営の画面は
 * 0 pt と「まだスコア変動の履歴がありません」のまま止まる。実測でそうなった。
 *
 * ここで固定するのは「動いている間だけポーリングする」こと。終了済み・開始前の
 * イベントまで叩き続けると、開きっぱなしのタブが無駄に API を打ち続ける。
 */
describe("useEventDetail auto-refresh (Issue 2987)", () => {
  const POLL_MS = 30_000;
  const RUNNING = {
    eventId: "e1",
    name: "Live Cup",
    startsAt: "2026-05-20T09:00:00.000Z",
    endsAt: "2026-05-20T18:00:00.000Z",
  };

  /** 進行中の時刻へ固定してから hook を立ち上げ、最初の取得を待つ。 */
  async function mount(detail: unknown, now: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    mockGetEvent.mockResolvedValue(detail);
    const rendered = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return rendered;
  }

  afterEach(() => vi.useRealTimers());

  it("should keep refreshing while the event is running", async () => {
    const { result } = await mount(RUNNING, "2026-05-20T12:00:00.000Z");
    expect(result.current.detail).toEqual(RUNNING);
    const afterMount = mockGetEvent.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    // 2 tick 分だけ増えていること。mount 時の 1 回と区別して数える。
    expect(mockGetEvent.mock.calls.length).toBe(afterMount + 2);
  });

  it("should not poll once the event has ended", async () => {
    const { result } = await mount(RUNNING, "2026-05-20T19:00:00.000Z");
    expect(result.current.detail).toEqual(RUNNING);
    const afterMount = mockGetEvent.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(mockGetEvent.mock.calls.length).toBe(afterMount);
  });

  it("should not poll before the event starts", async () => {
    await mount(RUNNING, "2026-05-20T08:00:00.000Z");
    const afterMount = mockGetEvent.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(mockGetEvent.mock.calls.length).toBe(afterMount);
  });

  it("should still refresh an event whose bounds are not specified", async () => {
    // #536 で backend は要求された field だけ返す。境界が無いことを「終了済み」と
    // 解釈すると、指定の緩いイベントが黙って固まる。開いている側へ倒す。
    const { result } = await mount({ eventId: "e1", name: "Open Cup" }, "2026-05-20T12:00:00.000Z");
    expect(result.current.detail).not.toBeNull();
    const afterMount = mockGetEvent.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(mockGetEvent.mock.calls.length).toBe(afterMount + 1);
  });
});
