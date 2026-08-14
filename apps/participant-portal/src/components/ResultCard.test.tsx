import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardResponse } from "../api/portal-client";
import { ResultCard, type ResultCardRuntime } from "./ResultCard";
import { ResultCardError } from "./result-card";

vi.mock("../i18n", () => ({
  useLang: () => "en",
  useT: () => (key: string) => key,
}));

function leaderboard(overrides: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    eventId: "event-id",
    entries: [
      {
        rank: 1,
        teamId: "team-id",
        teamName: "Cloud Ninjas",
        score: 500,
        completedProblems: 5,
        totalProblems: 5,
        isMyTeam: true,
      },
    ],
    endsAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function runtime(overrides: Partial<ResultCardRuntime> = {}): ResultCardRuntime {
  return {
    now: () => "2026-08-12T13:00:00.000Z",
    renderPng: vi.fn(async () => ({
      ok: true as const,
      value: new Blob(["png"], { type: "image/png" }),
    })),
    supportsFileShare: () => true,
    share: vi.fn(async () => undefined),
    download: vi.fn(),
    ...overrides,
  };
}

describe("ResultCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a responsive preview and both explicit user actions", () => {
    render(
      <ResultCard leaderboard={leaderboard()} eventTitle="TenkaCloud Battle" runtime={runtime()} />,
    );

    expect(screen.getByText("result_card.title")).toBeDefined();
    expect(screen.getByRole("img")).toHaveAttribute("width", "1200");
    expect(screen.getByRole("button", { name: "result_card.share_button" })).toBeDefined();
    expect(screen.getByRole("button", { name: "result_card.download_button" })).toBeDefined();
  });

  it("shows the live note before the event has ended", () => {
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={runtime({ now: () => "2026-08-12T11:00:00.000Z" })}
      />,
    );
    expect(screen.getByText("result_card.live_note")).toBeDefined();
    expect(screen.queryByText("result_card.final_note")).toBeNull();
  });

  it("fails closed when scores are frozen or the current team is missing", () => {
    const { rerender } = render(
      <ResultCard
        leaderboard={leaderboard({ scoreboardFrozen: true })}
        eventTitle="TenkaCloud Battle"
        runtime={runtime()}
      />,
    );
    expect(screen.queryByText("result_card.title")).toBeNull();

    rerender(
      <ResultCard
        leaderboard={leaderboard({ entries: [] })}
        eventTitle="TenkaCloud Battle"
        runtime={runtime()}
      />,
    );
    expect(screen.queryByText("result_card.title")).toBeNull();
  });

  it("downloads the generated PNG and reports success", async () => {
    const testRuntime = runtime();
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.download_button" }));

    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
    expect(screen.getByText("result_card.download_success")).toBeDefined();
    const [, filename] = vi.mocked(testRuntime.download).mock.calls[0] ?? [];
    expect(filename).toBe("tenkacloud-cloud-ninjas-final-20260812T130000Z.png");
  });

  it("shares a PNG file and treats AbortError as a quiet cancellation", async () => {
    const successfulRuntime = runtime();
    const { unmount } = render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={successfulRuntime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(successfulRuntime.share).toHaveBeenCalledTimes(1));
    const [file] = vi.mocked(successfulRuntime.share).mock.calls[0] ?? [];
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe("image/png");
    expect(screen.getByText("result_card.share_success")).toBeDefined();
    unmount();

    const cancelledRuntime = runtime({
      share: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={cancelledRuntime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(cancelledRuntime.share).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("result_card.error_header")).toBeNull();
    expect(screen.queryByText("result_card.share_success")).toBeNull();
  });

  it("keeps PNG download available when file sharing is unsupported", () => {
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={runtime({ supportsFileShare: () => false })}
      />,
    );

    expect(screen.queryByRole("button", { name: "result_card.share_button" })).toBeNull();
    expect(screen.getByRole("button", { name: "result_card.download_button" })).toBeDefined();
    expect(screen.getByText("result_card.share_unavailable")).toBeDefined();
  });

  it("shows an actionable error and allows retry after rasterization failure", async () => {
    const renderPng = vi.fn();
    renderPng.mockResolvedValueOnce({
      ok: false,
      error: new ResultCardError("png-encoding-failed", "failed"),
    });
    renderPng.mockResolvedValueOnce({
      ok: true,
      value: new Blob(["png"], { type: "image/png" }),
    });
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    const button = screen.getByRole("button", { name: "result_card.download_button" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());

    fireEvent.click(button);
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("result_card.error_header")).toBeNull();
  });

  it("prevents duplicate generation while an operation is in flight", async () => {
    let resolveRender:
      | ((value: Awaited<ReturnType<ResultCardRuntime["renderPng"]>>) => void)
      | undefined;
    const renderPng = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<ResultCardRuntime["renderPng"]>>>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    const button = screen.getByRole("button", { name: "result_card.download_button" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(renderPng).toHaveBeenCalledTimes(1);

    resolveRender?.({
      ok: true,
      value: new Blob(["png"], { type: "image/png" }),
    });
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
  });

  it("guards re-entrancy at the handler level, before the disabled button can take effect", async () => {
    // The two `fireEvent.click`s above are prevented by React committing `disabled`
    // between them — the DOM never dispatches a second click. Batching both dispatches
    // inside one `act()` defers that commit, so both synchronously reach the handler
    // and the in-flight ref guard itself (not just the UI) is what stops the second one.
    let resolveRender:
      | ((value: Awaited<ReturnType<ResultCardRuntime["renderPng"]>>) => void)
      | undefined;
    const renderPng = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<ResultCardRuntime["renderPng"]>>>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    const button = screen.getByRole("button", { name: "result_card.download_button" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(renderPng).toHaveBeenCalledTimes(1);

    resolveRender?.({
      ok: true,
      value: new Blob(["png"], { type: "image/png" }),
    });
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
  });

  it("treats a plain cancellation-shaped object the same as a real AbortError", async () => {
    const testRuntime = runtime({
      share: vi.fn(async () => {
        // Some environments reject with a plain object rather than a real DOMException;
        // the quiet-cancellation check must recognize both shapes.
        throw { name: "AbortError" };
      }),
    });
    render(
      <ResultCard leaderboard={leaderboard()} eventTitle="TenkaCloud Battle" runtime={testRuntime} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("result_card.error_header")).toBeNull();
    expect(screen.queryByText("result_card.share_success")).toBeNull();
  });

  it("shows an error and never calls share when rasterization fails before sharing", async () => {
    const renderPng = vi.fn(async () => ({
      ok: false as const,
      error: new ResultCardError("canvas-context-unavailable", "failed"),
    }));
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard leaderboard={leaderboard()} eventTitle="TenkaCloud Battle" runtime={testRuntime} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
    expect(testRuntime.share).not.toHaveBeenCalled();
  });

  it("shows an error when the download action itself throws", async () => {
    const testRuntime = runtime({
      download: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    render(
      <ResultCard leaderboard={leaderboard()} eventTitle="TenkaCloud Battle" runtime={testRuntime} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.download_button" }));
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
  });

  it("shows an error for a genuine (non-cancellation) share failure", async () => {
    const testRuntime = runtime({
      share: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    });
    render(
      <ResultCard leaderboard={leaderboard()} eventTitle="TenkaCloud Battle" runtime={testRuntime} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
    expect(screen.queryByText("result_card.share_success")).toBeNull();
  });
});
