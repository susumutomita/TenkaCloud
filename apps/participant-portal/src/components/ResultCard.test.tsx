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

/** Deferred promise helper for simulating an in-flight rasterize. */
function deferredRenderPngResult() {
  let resolve!: (value: Awaited<ReturnType<ResultCardRuntime["renderPng"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<ResultCardRuntime["renderPng"]>>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    expect(screen.getByRole("button", { name: "result_card.prepare_button" })).toBeDefined();
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

  it("does not rasterize a PNG before any explicit user action", () => {
    const testRuntime = runtime();
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );
    expect(testRuntime.renderPng).not.toHaveBeenCalled();
    expect(testRuntime.share).not.toHaveBeenCalled();
    expect(testRuntime.download).not.toHaveBeenCalled();
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

  it("prepares on the first click without sharing, then shares the cached file on the second click", async () => {
    const testRuntime = runtime();
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    // Stage 1: explicit "prepare" click rasterizes but must not call share yet.
    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    await waitFor(() => expect(testRuntime.renderPng).toHaveBeenCalledTimes(1));
    expect(testRuntime.share).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "result_card.share_button" })).toBeDefined(),
    );
    expect(screen.getByText("result_card.prepared_hint")).toBeDefined();

    // Stage 2: the second click shares the already-rasterized file without rasterizing again.
    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(1));
    expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);
    const [file] = vi.mocked(testRuntime.share).mock.calls[0] ?? [];
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe("image/png");
    expect(screen.getByText("result_card.share_success")).toBeDefined();
  });

  it("shares again from the cached file without re-rasterizing", async () => {
    const testRuntime = runtime();
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    await waitFor(() => expect(testRuntime.renderPng).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(2));
    expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);
  });

  it("treats a share cancellation (AbortError) as a quiet no-op after the file is prepared", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    fireEvent.click(await screen.findByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(cancelledRuntime.share).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("result_card.error_header")).toBeNull();
    expect(screen.queryByText("result_card.share_success")).toBeNull();
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
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    fireEvent.click(await screen.findByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("result_card.error_header")).toBeNull();
    expect(screen.queryByText("result_card.share_success")).toBeNull();
  });

  it("shows an actionable error for a genuine (non-cancellation) share failure and allows retry", async () => {
    let shouldFail = true;
    const testRuntime = runtime({
      share: vi.fn(async () => {
        if (shouldFail) throw new Error("network unreachable");
      }),
    });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    const shareButton = await screen.findByRole("button", { name: "result_card.share_button" });
    fireEvent.click(shareButton);
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
    expect(screen.queryByText("result_card.share_success")).toBeNull();

    // Retry: the cached file is still valid, so retrying must not rasterize again.
    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
    await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(2));
    expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);
    expect(screen.getByText("result_card.share_success")).toBeDefined();
    expect(screen.queryByText("result_card.error_header")).toBeNull();
  });

  it("shows an error and never calls share when rasterization fails before sharing", async () => {
    const renderPng = vi.fn(async () => ({
      ok: false as const,
      error: new ResultCardError("canvas-context-unavailable", "failed"),
    }));
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
    expect(testRuntime.share).not.toHaveBeenCalled();
    // Preparation failed, so the button must still be offering to prepare (not to share).
    expect(screen.getByRole("button", { name: "result_card.prepare_button" })).toBeDefined();
  });

  it("keeps PNG download available when file sharing is unsupported", () => {
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={runtime({ supportsFileShare: () => false })}
      />,
    );

    expect(screen.queryByRole("button", { name: "result_card.prepare_button" })).toBeNull();
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

  it("prevents duplicate generation while an operation is in flight (download)", async () => {
    const { promise, resolve } = deferredRenderPngResult();
    const renderPng = vi.fn(() => promise);
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

    resolve({ ok: true, value: new Blob(["png"], { type: "image/png" }) });
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
  });

  it("prevents duplicate generation on rapid double click of the prepare/share button", async () => {
    const { promise, resolve } = deferredRenderPngResult();
    const renderPng = vi.fn(() => promise);
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    const button = screen.getByRole("button", { name: "result_card.prepare_button" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(renderPng).toHaveBeenCalledTimes(1);

    resolve({ ok: true, value: new Blob(["png"], { type: "image/png" }) });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "result_card.share_button" })).toBeDefined(),
    );
  });

  it("guards re-entrancy on the actual share call once a file is prepared", async () => {
    let resolveShare!: () => void;
    let shareCalls = 0;
    const testRuntime = runtime({
      share: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            shareCalls += 1;
            resolveShare = resolve;
          }),
      ),
    });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    const shareButton = await screen.findByRole("button", { name: "result_card.share_button" });

    fireEvent.click(shareButton);
    fireEvent.click(shareButton);
    expect(shareCalls).toBe(1);
    expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);

    resolveShare();
    await waitFor(() => expect(screen.getByText("result_card.share_success")).toBeDefined());
  });

  it("reuses the prepared-for-share file when Download is clicked afterwards", async () => {
    const testRuntime = runtime();
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
    await screen.findByRole("button", { name: "result_card.share_button" });

    fireEvent.click(screen.getByRole("button", { name: "result_card.download_button" }));
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
    expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);
  });

  it("guards re-entrancy at the prepare/share handler level, before the disabled button can take effect", async () => {
    const { promise, resolve } = deferredRenderPngResult();
    const renderPng = vi.fn(() => promise);
    const testRuntime = runtime({ renderPng });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    const button = screen.getByRole("button", { name: "result_card.prepare_button" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(renderPng).toHaveBeenCalledTimes(1);

    resolve({ ok: true, value: new Blob(["png"], { type: "image/png" }) });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "result_card.share_button" })).toBeDefined(),
    );
  });

  it("guards re-entrancy at the handler level, before the disabled button can take effect", async () => {
    // The two `fireEvent.click`s above are prevented by React committing `disabled`
    // between them — the DOM never dispatches a second click. Batching both dispatches
    // inside one `act()` defers that commit, so both synchronously reach the handler
    // and the in-flight ref guard itself (not just the UI) is what stops the second one.
    const { promise, resolve } = deferredRenderPngResult();
    const renderPng = vi.fn(() => promise);
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

    resolve({ ok: true, value: new Blob(["png"], { type: "image/png" }) });
    await waitFor(() => expect(testRuntime.download).toHaveBeenCalledTimes(1));
  });

  it("shows an error when the download action itself throws", async () => {
    const testRuntime = runtime({
      download: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    render(
      <ResultCard
        leaderboard={leaderboard()}
        eventTitle="TenkaCloud Battle"
        runtime={testRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "result_card.download_button" }));
    await waitFor(() => expect(screen.getByText("result_card.error_header")).toBeDefined());
  });

  describe("snapshot freshness (source-key invalidation and stale discard)", () => {
    it("discards a prepared PNG once the visible snapshot changes", async () => {
      const testRuntime = runtime();
      const { rerender } = render(
        <ResultCard
          leaderboard={leaderboard()}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
      await screen.findByRole("button", { name: "result_card.share_button" });

      // A later poll changes the score: the prepared PNG must be invalidated immediately,
      // even though nothing was clicked.
      rerender(
        <ResultCard
          leaderboard={leaderboard({
            entries: [
              {
                rank: 1,
                teamId: "team-id",
                teamName: "Cloud Ninjas",
                score: 650,
                completedProblems: 5,
                totalProblems: 5,
                isMyTeam: true,
              },
            ],
          })}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "result_card.prepare_button" })).toBeDefined(),
      );

      // Clicking now must re-rasterize the new snapshot rather than sharing the stale one.
      fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
      await waitFor(() => expect(testRuntime.renderPng).toHaveBeenCalledTimes(2));
      expect(testRuntime.share).not.toHaveBeenCalled();
    });

    it("does not invalidate the prepared PNG merely because generatedAt ticks forward on an unchanged poll", async () => {
      const testRuntime = runtime();
      const { rerender } = render(
        <ResultCard
          leaderboard={leaderboard()}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
      await screen.findByRole("button", { name: "result_card.share_button" });

      // Re-render with the identical leaderboard values (a fresh object reference, as a
      // real poll would produce) — nothing displayable changed, so the cache must survive.
      rerender(
        <ResultCard
          leaderboard={leaderboard()}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      expect(screen.getByRole("button", { name: "result_card.share_button" })).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "result_card.share_button" }));
      await waitFor(() => expect(testRuntime.share).toHaveBeenCalledTimes(1));
      expect(testRuntime.renderPng).toHaveBeenCalledTimes(1);
    });

    it("discards a stale rasterize that completes after the snapshot has already moved on", async () => {
      const { promise, resolve } = deferredRenderPngResult();
      const renderPng = vi.fn(() => promise);
      const testRuntime = runtime({ renderPng });
      const { rerender } = render(
        <ResultCard
          leaderboard={leaderboard()}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
      await waitFor(() => expect(renderPng).toHaveBeenCalledTimes(1));

      // The snapshot moves on to a new score while the first rasterize is still pending.
      rerender(
        <ResultCard
          leaderboard={leaderboard({
            entries: [
              {
                rank: 2,
                teamId: "team-id",
                teamName: "Cloud Ninjas",
                score: -40,
                completedProblems: 3,
                totalProblems: 5,
                isMyTeam: true,
              },
            ],
          })}
          eventTitle="TenkaCloud Battle"
          runtime={testRuntime}
        />,
      );

      // The stale rasterize now completes for the OLD snapshot.
      resolve({ ok: true, value: new Blob(["stale-png"], { type: "image/png" }) });

      // It must never be surfaced as a ready-to-share file for the new snapshot.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "result_card.prepare_button" })).toBeDefined(),
      );
      expect(screen.queryByRole("button", { name: "result_card.share_button" })).toBeNull();
      expect(testRuntime.share).not.toHaveBeenCalled();

      // A fresh prepare against the current (negative-score) snapshot must rasterize again.
      fireEvent.click(screen.getByRole("button", { name: "result_card.prepare_button" }));
      expect(renderPng).toHaveBeenCalledTimes(2);
    });
  });
});
