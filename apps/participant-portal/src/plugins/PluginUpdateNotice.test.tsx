import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginUpdateNotice, ReloadPortal } from "./PluginUpdateNotice";

vi.mock("virtual:portal-plugin-versions", () => ({ default: { a: "a".repeat(64) } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("detects a deployed build on focus and preserves the typed answer", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ a: "a".repeat(64), b: "c".repeat(64) }))
    .mockResolvedValue(Response.json({ a: "b".repeat(64) }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <>
      <input aria-label="answer" />
      <PluginUpdateNotice problemId="a" locale="ja" />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "my unfinished answer" } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("問題画面の更新があります")).not.toBeInTheDocument();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(await screen.findByText("問題画面の更新があります")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("my unfinished answer");
  expect(screen.getByRole("button", { name: "入力を破棄して再読み込み" })).toBeInTheDocument();
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
});

it.each(["offline", "error", "no-entry"])("does not announce a deployment on %s", async (mode) => {
  const fetcher =
    mode === "offline"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi
          .fn()
          .mockResolvedValue(
            new Response("<h1>Unavailable</h1>", { status: mode === "error" ? 503 : 200 }),
          );
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice problemId="a" locale="en" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container).toBeEmptyDOMElement();
});

it("reloads only after the explicit discard action", () => {
  const reload = vi.fn();
  render(<ReloadPortal locale="en" reload={reload} />);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard input and reload" }));
  expect(reload).toHaveBeenCalledOnce();
});

it("aborts an outstanding check when the plugin screen unmounts", () => {
  const fetcher = vi.fn().mockReturnValue(
    new Promise<Response>(() => {
      // Keep this request outstanding until the component cancels it.
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice problemId="a" locale="ja" />);
  const signal = fetcher.mock.calls[0]?.[1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it("times out a stalled check and retries on the next minute", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    )
    .mockResolvedValueOnce(Response.json({ a: "b".repeat(64) }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice problemId="a" locale="en" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(view.container).toBeEmptyDOMElement();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByText("An updated problem screen is available")).toBeInTheDocument();
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("skips background tabs and checks again when they regain focus", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ a: "b".repeat(64) }));
  vi.stubGlobal("fetch", fetcher);
  render(<PluginUpdateNotice problemId="a" locale="en" />);
  expect(fetcher).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(screen.getByText("An updated problem screen is available")).toBeInTheDocument();
});

it("ignores another problem's update and a missing current problem", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ a: "a".repeat(64), b: "b".repeat(64) }));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice problemId="a" locale="ja" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container).toBeEmptyDOMElement();
  fetcher.mockResolvedValue(Response.json({ b: "c".repeat(64) }));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(view.container).toBeEmptyDOMElement();
});

it("clears the displayed warning when navigating to another problem", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ a: "b".repeat(64) })));
  const view = render(<PluginUpdateNotice problemId="a" locale="ja" />);
  expect(await screen.findByText("問題画面の更新があります")).toBeInTheDocument();
  view.rerender(<PluginUpdateNotice problemId="unknown" locale="ja" />);
  expect(view.container).toBeEmptyDOMElement();
});
