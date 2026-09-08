import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { moduleEntries, PluginUpdateNotice, ReloadPortal } from "./PluginUpdateNotice";

afterEach(() => {
  document.querySelectorAll("script[data-update-test]").forEach((node) => {
    node.remove();
  });
  vi.unstubAllGlobals();
});

function entry() {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/assets/index-old.js";
  script.dataset.updateTest = "true";
  document.head.appendChild(script);
}

it("compares normalized entry URLs without executing fetched scripts", () => {
  const doc = new DOMParser().parseFromString(
    '<script type="module" src="./assets/main.js"></script><script src="config.js"></script>',
    "text/html",
  );
  expect(moduleEntries(doc, "https://example.com/portal/")).toEqual([
    "https://example.com/portal/assets/main.js",
  ]);
});

it("detects a deployed build on focus and preserves the typed answer", async () => {
  entry();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('<script type="module" src="/assets/index-old.js"></script>'),
    )
    .mockResolvedValue(new Response('<script type="module" src="/assets/index-new.js"></script>'));
  vi.stubGlobal("fetch", fetcher);
  render(
    <>
      <input aria-label="answer" />
      <PluginUpdateNotice locale="ja" />
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
  entry();
  const fetcher =
    mode === "offline"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi
          .fn()
          .mockResolvedValue(
            new Response("<h1>Unavailable</h1>", { status: mode === "error" ? 503 : 200 }),
          );
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice locale="en" />);
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
  entry();
  const fetcher = vi.fn().mockReturnValue(Promise.withResolvers<Response>().promise);
  vi.stubGlobal("fetch", fetcher);
  const view = render(<PluginUpdateNotice locale="ja" />);
  const signal = fetcher.mock.calls[0]?.[1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
