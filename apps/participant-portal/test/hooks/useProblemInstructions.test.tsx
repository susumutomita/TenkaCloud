import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemInstructions } from "../../src/data/problems";
import { useProblemInstructions } from "../../src/hooks/useProblemInstructions";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../src/data/problems", () => ({ loadProblemInstructions: load }));

beforeEach(() => load.mockReset());

describe("useProblemInstructions", () => {
  it("does not fetch locked or missing problems, then loads after unlocking", async () => {
    load.mockResolvedValue({ instructions: "JA", englishInstructions: "EN" });
    const { result, rerender } = renderHook(
      ({ id, enabled }) => useProblemInstructions(id, enabled),
      { initialProps: { id: undefined as string | undefined, enabled: true } },
    );
    expect(load).not.toHaveBeenCalled();
    rerender({ id: "a", enabled: false });
    expect(load).not.toHaveBeenCalled();
    rerender({ id: "a", enabled: true });
    await waitFor(() => expect(result.current.value?.englishInstructions).toBe("EN"));
    expect(load).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("ignores late responses after newer navigation and supports returning to the first problem", async () => {
    let resolveFirst!: (value: ProblemInstructions) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    load.mockResolvedValueOnce({ instructions: "second" });
    const { result, rerender } = renderHook(({ id }) => useProblemInstructions(id, true), {
      initialProps: { id: "a" },
    });
    rerender({ id: "b" });
    await waitFor(() => expect(result.current.value?.instructions).toBe("second"));
    await act(async () => resolveFirst({ instructions: "stale first" }));
    expect(result.current.value?.instructions).toBe("second");
    load.mockResolvedValueOnce({ instructions: "first again" });
    rerender({ id: "a" });
    expect(result.current.value).toBeUndefined();
    await waitFor(() => expect(result.current.value?.instructions).toBe("first again"));
  });

  it("discards a response after a problem becomes locked", async () => {
    let resolve!: (value: ProblemInstructions) => void;
    load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = renderHook(({ enabled }) => useProblemInstructions("a", enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    await act(async () => resolve({ instructions: "hidden" }));
    expect(result.current.value).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it("ignores a failed request after navigating away", async () => {
    let reject!: (error: Error) => void;
    load.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    load.mockResolvedValueOnce({ instructions: "current" });
    const { result, rerender } = renderHook(({ id }) => useProblemInstructions(id, true), {
      initialProps: { id: "a" },
    });
    rerender({ id: "b" });
    await waitFor(() => expect(result.current.value?.instructions).toBe("current"));
    await act(async () => reject(new Error("stale failure")));
    expect(result.current.error).toBeUndefined();
  });

  it("shows failures and retries without treating failed content as an empty success", async () => {
    load.mockRejectedValueOnce(new Error("network failed"));
    load.mockResolvedValueOnce({ instructions: "recovered" });
    const { result } = renderHook(() => useProblemInstructions("a", true));
    await waitFor(() => expect(result.current.error).toContain("network failed"));
    expect(result.current.loading).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.value?.instructions).toBe("recovered"));
    expect(result.current.error).toBeUndefined();
  });

  it("allows runtime catalogs or problems with no bundled narrative", async () => {
    load.mockResolvedValue(undefined);
    const { result } = renderHook(() => useProblemInstructions("runtime-only", true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.value).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });
});
