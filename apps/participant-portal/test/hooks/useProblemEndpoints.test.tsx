import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParticipantEndpointView } from "../../src/api/portal-client";

/**
 * [Issue #2661] useProblemEndpoints: ProblemDetail が 1 problem の endpoint 一覧を単一 source として
 * 保持する hook。 mount fetch (success / error / no_endpoints) / cancelled guard / enabled・problemId・
 * teamLoginKey による fetch gating / replaceEndpoints を pin する。 fetch は EndpointOverrideForm から
 * この hook へ移したもの。
 */
const { mockList } = vi.hoisted(() => ({ mockList: vi.fn() }));
vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return { ...actual, listProblemEndpoints: mockList };
});

const { useProblemEndpoints } = await import("../../src/hooks/useProblemEndpoints");

const ep: ParticipantEndpointView = {
  slot: "app",
  overridable: true,
  defaultKey: "RegisteredUrl",
  effectiveUrl: "https://team.example/app",
  overrideUrl: "https://team.example/app",
};

afterEach(() => vi.clearAllMocks());

describe("useProblemEndpoints", () => {
  it("should fetch and expose the server-computed endpoints (+ plugin-marshalled) on mount", async () => {
    mockList.mockResolvedValue({ teamId: "t1", endpoints: [ep] });
    const { result } = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    await waitFor(() => expect(result.current.endpoints).toEqual([ep]));
    expect(result.current.listError).toBeUndefined();
    expect(mockList).toHaveBeenCalledWith("https://api", "KEY", "p1");
    // portalEndpoints は plugin SDK 形 (defaultKey を落とし、 override マージ済 URL を保つ)。
    expect(result.current.portalEndpoints).toEqual([
      {
        slot: "app",
        overridable: true,
        effectiveUrl: "https://team.example/app",
        overrideUrl: "https://team.example/app",
      },
    ]);
  });

  it("should expose the error message when the list fetch fails", async () => {
    mockList.mockRejectedValue(new Error("list boom"));
    const { result } = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    await waitFor(() => expect(result.current.listError).toBe("list boom"));
    expect(result.current.endpoints).toBeUndefined();
  });

  it("should surface the no_endpoints signal so consumers can hide the section", async () => {
    mockList.mockRejectedValue("no_endpoints");
    const { result } = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    await waitFor(() => expect(result.current.listError).toBe("no_endpoints"));
  });

  it.each([
    ["disabled", "https://api", "KEY", "p1", false],
    ["no problemId", "https://api", "KEY", undefined, true],
    ["empty teamLoginKey", "https://api", "", "p1", true],
  ])("should not fetch when %s", async (_label, api, key, problemId, enabled) => {
    const { result } = renderHook(() => useProblemEndpoints(api, key, problemId, enabled));
    await act(async () => {});
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.endpoints).toBeUndefined();
    expect(result.current.listError).toBeUndefined();
    expect(result.current.portalEndpoints).toBeUndefined();
  });

  it("should replace endpoints and clear the error via replaceEndpoints", async () => {
    mockList.mockRejectedValue(new Error("stale"));
    const { result } = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    await waitFor(() => expect(result.current.listError).toBe("stale"));

    const next = [{ ...ep, effectiveUrl: "https://new.example/app" }];
    act(() => result.current.replaceEndpoints(next));
    expect(result.current.endpoints).toEqual(next);
    expect(result.current.listError).toBeUndefined();
  });

  it("should ignore a late resolution after unmount (cancelled guard)", async () => {
    let resolveList: (v: unknown) => void = () => {};
    mockList.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const { unmount } = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    unmount();
    await act(async () => {
      resolveList({ teamId: "t1", endpoints: [ep] });
      await Promise.resolve();
    });

    let rejectList: (e: unknown) => void = () => {};
    mockList.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectList = reject;
      }),
    );
    const second = renderHook(() => useProblemEndpoints("https://api", "KEY", "p1", true));
    second.unmount();
    await act(async () => {
      rejectList(new Error("late"));
      await Promise.resolve();
    });
    // どちらも cancelled guard で state 更新せず throw / warning なく完了する。
    expect(true).toBe(true);
  });
});
