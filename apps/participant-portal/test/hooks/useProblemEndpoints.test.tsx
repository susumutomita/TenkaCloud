import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockListProblemEndpoints } = vi.hoisted(() => ({
  mockListProblemEndpoints: vi.fn(),
}));

vi.mock("../../src/api/portal-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/portal-client")>();
  return { ...actual, listProblemEndpoints: mockListProblemEndpoints };
});

const { useProblemEndpoints } = await import("../../src/hooks/useProblemEndpoints");

const args = {
  apiBaseUrl: "https://api.example.com",
  teamLoginKey: "TEAM-KEY",
  problemId: "stackstack",
  enabled: true,
};

afterEach(() => vi.clearAllMocks());

describe("useProblemEndpoints", () => {
  it("should load the authoritative endpoint registry once and expose shared updates", async () => {
    const endpoints = [
      {
        slot: "app",
        overridable: true,
        defaultKey: "RegisteredUrl",
        overrideUrl: "https://override.example.com",
        effectiveUrl: "https://override.example.com",
      },
    ];
    mockListProblemEndpoints.mockResolvedValue({ teamId: "team-1", endpoints });

    const { result } = renderHook(() => useProblemEndpoints(args));

    await waitFor(() => expect(result.current.endpoints).toEqual(endpoints));
    expect(mockListProblemEndpoints).toHaveBeenCalledOnce();
    expect(mockListProblemEndpoints).toHaveBeenCalledWith(
      args.apiBaseUrl,
      args.teamLoginKey,
      args.problemId,
      expect.any(AbortSignal),
    );

    const afterClear = [
      {
        slot: "app",
        overridable: true,
        defaultKey: "RegisteredUrl",
      },
    ];
    act(() => result.current.replaceEndpoints(afterClear));
    expect(result.current.endpoints).toEqual(afterClear);
  });

  it("should expose list failures instead of silently substituting an empty registry", async () => {
    mockListProblemEndpoints.mockRejectedValue(new Error("endpoint registry unavailable"));

    const { result } = renderHook(() => useProblemEndpoints(args));

    await waitFor(() => expect(result.current.error).toBe("endpoint registry unavailable"));
    expect(result.current.endpoints).toBeUndefined();
  });

  it("should not fetch while endpoint UI is disabled", () => {
    const { result } = renderHook(() => useProblemEndpoints({ ...args, enabled: false }));

    expect(mockListProblemEndpoints).not.toHaveBeenCalled();
    expect(result.current.endpoints).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it("should hide stale data and reject a late mutation update after the problem changes", async () => {
    const firstEndpoints = [
      {
        slot: "first",
        overridable: true,
        defaultKey: "FirstUrl",
        effectiveUrl: "https://first.example.com",
      },
    ];
    let resolveSecond: ((value: unknown) => void) | undefined;
    mockListProblemEndpoints
      .mockResolvedValueOnce({ teamId: "team-1", endpoints: firstEndpoints })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const { result, rerender } = renderHook(
      ({ problemId }) => useProblemEndpoints({ ...args, problemId }),
      { initialProps: { problemId: "first" } },
    );
    await waitFor(() => expect(result.current.endpoints).toEqual(firstEndpoints));
    const replaceFirstEndpoints = result.current.replaceEndpoints;

    rerender({ problemId: "second" });
    expect(result.current.endpoints).toBeUndefined();

    act(() => replaceFirstEndpoints(firstEndpoints));
    expect(result.current.endpoints).toBeUndefined();

    const secondEndpoints = [
      {
        slot: "second",
        overridable: true,
        defaultKey: "SecondUrl",
        effectiveUrl: "https://second.example.com",
      },
    ];
    await act(async () => {
      resolveSecond?.({ teamId: "team-1", endpoints: secondEndpoints });
      await Promise.resolve();
    });
    expect(result.current.endpoints).toEqual(secondEndpoints);
  });

  it("should ignore late resolution and rejection after the request is aborted", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    mockListProblemEndpoints.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const resolved = renderHook(() => useProblemEndpoints(args));
    resolved.unmount();
    await act(async () => {
      resolveRequest?.({ teamId: "team-1", endpoints: [] });
      await Promise.resolve();
    });

    let rejectRequest: ((reason: unknown) => void) | undefined;
    mockListProblemEndpoints.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectRequest = reject;
      }),
    );
    const rejected = renderHook(() => useProblemEndpoints(args));
    rejected.unmount();
    await act(async () => {
      rejectRequest?.(new Error("late failure"));
      await Promise.resolve();
    });

    expect(mockListProblemEndpoints).toHaveBeenCalledTimes(2);
  });
});
