import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client";
import { useEventDetail } from "../../src/hooks/useEventDetail";

/**
 * Issue #3226: the local host follows in-flight environment work every few seconds; the cloud
 * console keeps its single live-event poll and does not poll a finished event at all.
 */
const { mockGetEvent } = vi.hoisted(() => ({ mockGetEvent: vi.fn() }));
vi.mock("../../src/api/events-client", () => ({ getEvent: mockGetEvent }));

const CLIENT = createApiClient("http://127.0.0.1:5174/api", "a.e30.c");
function detail(status: string, operation?: string) {
  return {
    eventId: "e1",
    status: "DEPLOYING",
    // Not running: the 30s live-event poll is off, so only the in-flight poll can refetch.
    startsAt: "2020-01-01T00:00:00Z",
    endsAt: "2020-01-02T00:00:00Z",
    deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status, operation }] },
  };
}

async function fetchesAfter(ms: number, args: Parameters<typeof useEventDetail>[0]) {
  renderHook(() => useEventDetail(args));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const initial = mockGetEvent.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  return mockGetEvent.mock.calls.length - initial;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useEventDetail in-flight polling", () => {
  it("refetches every 3s on the local host while an environment is changing", async () => {
    mockGetEvent.mockResolvedValue(detail("IN_PROGRESS"));
    const extra = await fetchesAfter(6_500, {
      apiClient: CLIENT,
      eventId: "e1",
      eventIdValid: true,
      inFlightPollMs: 3_000,
    });
    expect(extra).toBe(2);
  });

  it("follows a single-environment operation even while its status is settled", async () => {
    mockGetEvent.mockResolvedValue(detail("COMPLETE", "stop"));
    const extra = await fetchesAfter(3_500, {
      apiClient: CLIENT,
      eventId: "e1",
      eventIdValid: true,
      inFlightPollMs: 3_000,
    });
    expect(extra).toBe(1);
  });

  it("stops once nothing is in flight", async () => {
    mockGetEvent.mockResolvedValue(detail("COMPLETE"));
    const extra = await fetchesAfter(10_000, {
      apiClient: CLIENT,
      eventId: "e1",
      eventIdValid: true,
      inFlightPollMs: 3_000,
    });
    expect(extra).toBe(0);
  });

  it("refreshes Cloud preparation before event start and stops after completion", async () => {
    const pending = {
      ...detail("IN_PROGRESS"),
      startsAt: "2099-01-01T00:00:00Z",
      endsAt: "2099-01-02T00:00:00Z",
    };
    const ready = {
      ...pending,
      deploymentsByProblem: { p: [{ jobId: "J", teamId: "A", status: "COMPLETE" }] },
    };
    mockGetEvent.mockResolvedValueOnce(pending).mockResolvedValue(ready);
    const { result } = renderHook(() =>
      useEventDetail({ apiClient: CLIENT, eventId: "e1", eventIdValid: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.detail).toEqual(pending);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.detail).toEqual(ready);
    const calls = mockGetEvent.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockGetEvent.mock.calls.length).toBe(calls);
  });

  it("follows Cloud environment work every 30s outside the scoring window", async () => {
    mockGetEvent.mockResolvedValue(detail("IN_PROGRESS"));
    const extra = await fetchesAfter(60_000, {
      apiClient: CLIENT,
      eventId: "e1",
      eventIdValid: true,
    });
    expect(extra).toBe(2);
  });
});
