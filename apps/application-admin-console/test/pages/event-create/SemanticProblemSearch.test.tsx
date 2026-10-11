import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemSummary } from "../../../src/data/problems";
import type { HostCatalog } from "../../../src/pages/event-create/LocalHostEventCreate";
import { SemanticProblemSearch } from "../../../src/pages/event-create/SemanticProblemSearch";

vi.mock("../../../src/i18n", () => ({
  useI18n: () => ({ locale: "ja" }),
  useT: () => (key: string) => key,
}));
const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const posted = vi.fn();
const terminated = vi.fn();
let holdIndex = false;
let holdAction = "";
let failureAction = "";
let malformedAction = "";
let crash = false;
let deliverLate: ((data: object) => void) | undefined;

const problems = ["one", "two"].map((id) => ({
  id,
  name: id,
  shortDescription: "公開概要",
  category: "Challenge",
  status: "ready",
  difficulty: 1,
  tags: [],
  runtime: { provider: "docker", engine: "compose" },
  estimatedDuration: "10分",
})) as ProblemSummary[];
const catalog: HostCatalog = {
  supported: new Set(["one", "two"]),
  cloud: new Set(),
  limits: { maxTeams: 40, maxEventJobs: 4 },
  loading: false,
  error: null,
};
beforeEach(() => {
  posted.mockClear();
  terminated.mockClear();
  holdIndex = false;
  holdAction = "";
  failureAction = "";
  malformedAction = "";
  crash = false;
  deliverLate = undefined;
  Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: { data: object }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        deliverLate = (data) => this.onmessage?.({ data });
      }
      terminate = terminated;
      postMessage(request: { action: string; request: number }) {
        posted(request);
        if (crash) {
          queueMicrotask(() => this.onerror?.());
          return;
        }
        if (failureAction === request.action) {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { request: request.request, kind: "error", data: "WebGPU execution failed" },
            }),
          );
          return;
        }
        this.onmessage?.({
          data: { request: request.request - 1, kind: "error", data: "stale error" },
        });
        this.onmessage?.({
          data: {
            request: request.request,
            kind: "progress",
            data: { status: "progress", progress: 42 },
          },
        });
        this.onmessage?.({
          data: {
            request: request.request,
            kind: "progress",
            data: { status: "index", completed: 1, total: 2 },
          },
        });
        this.onmessage?.({
          data: {
            request: request.request,
            kind: "progress",
            data: { status: "done", file: "model", loaded: 1, total: 1 },
          },
        });
        if ((holdIndex && request.action === "index") || holdAction === request.action) return;
        const indexData = { elapsedMs: 1, vectors: problems.map((p) => ({ id: p.id, vector })) };
        const queryData = request.action === "query" ? { elapsedMs: 1, vector } : { elapsedMs: 1 };
        const data = request.action === "index" ? indexData : queryData;
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              request: request.request,
              kind: "result",
              data: malformedAction === request.action ? {} : data,
            },
          }),
        );
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function start(props = {}) {
  const onCandidates = vi.fn();
  const view = render(
    <SemanticProblemSearch
      problems={problems}
      catalog={catalog}
      onCandidates={onCandidates}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "精度向上を準備する（任意）" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "検索を終了する" })).toBeEnabled());
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  return { ...view, onCandidates };
}
describe("semantic UI with a mock worker (not inference evidence)", () => {
  it("handles IME and Shift Enter, narrowing candidates without selecting problems", async () => {
    const { onCandidates } = await start();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "障害調査" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(posted).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCandidates).toHaveBeenLastCalledWith(["one", "two"]));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /置き換える/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "目的による絞り込みを解除" }));
    expect(onCandidates).toHaveBeenLastCalledWith(null);
  });
  it("stops an actual pending RPC and can reload without a late result", async () => {
    await start();
    holdIndex = true;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "調査" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "検索を終了する" })));
    expect(terminated).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeEnabled();
    holdIndex = false;
    fireEvent.click(screen.getByRole("button", { name: "精度向上を準備する（任意）" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "検索を終了する" })).toBeEnabled(),
    );
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  });
  it("clears results when hard filters change during a pending request", async () => {
    const { rerender, onCandidates } = await start();
    holdIndex = true;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "調査" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    rerender(<SemanticProblemSearch problems={[]} catalog={catalog} onCandidates={onCandidates} />);
    await waitFor(() => expect(terminated).toHaveBeenCalled());
    expect(onCandidates).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeEnabled();
  });
  it("terminates and enables reload after the deadline (mock clock, not measured latency)", async () => {
    await start();
    holdIndex = true;
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "調査" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await act(async () => vi.advanceTimersByTimeAsync(180001));
    expect(terminated).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("3分");
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeEnabled();
  });
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* jsdom has no layout; scroll evidence is covered by the real browser harness. */
      }
      disconnect() {
        /* no observers allocated by this test stub. */
      }
    },
  );
});

describe("search recovery and privacy boundaries with mock workers", () => {
  it("ignores a resolved load when cancellation happens before its continuation", async () => {
    holdAction = "load";
    render(<SemanticProblemSearch problems={problems} catalog={catalog} onCandidates={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "精度向上を準備する（任意）" }));
    await act(async () => {
      deliverLate?.({
        request: posted.mock.lastCall?.[0].request,
        kind: "result",
        data: { elapsedMs: 1 },
      });
      fireEvent.click(screen.getByRole("button", { name: "検索を終了する" }));
    });
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });
  it("ignores a resolved query when cancellation happens before its continuation", async () => {
    const { onCandidates } = await start();
    holdAction = "query";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SQL" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await waitFor(() => expect(posted.mock.lastCall?.[0].action).toBe("query"));
    await act(async () => {
      deliverLate?.({
        request: posted.mock.lastCall?.[0].request,
        kind: "result",
        data: { elapsedMs: 1, vector },
      });
      fireEvent.click(screen.getByRole("button", { name: "検索を終了する" }));
    });
    expect(onCandidates).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("list", { name: "問題の候補" })).not.toBeInTheDocument();
  });
  it("does not download without preparation and keeps manual fallback on unsupported browsers", () => {
    Reflect.deleteProperty(navigator, "gpu");
    render(<SemanticProblemSearch problems={problems} catalog={catalog} onCandidates={vi.fn()} />);
    expect(screen.getByText(/このブラウザでは精度向上の機能を使えません/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "精度向上を準備する（任意）" }),
    ).not.toBeInTheDocument();
    expect(posted).not.toHaveBeenCalled();
  });
  it("does not prepare while the authenticated catalog is unavailable", () => {
    render(
      <SemanticProblemSearch
        problems={problems}
        catalog={{ ...catalog, loading: true, error: "offline" }}
        onCandidates={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeDisabled();
    expect(posted).not.toHaveBeenCalled();
  });
  it.each(["message", "crash"])("recovers from load %s without false readiness", async (mode) => {
    failureAction = mode === "message" ? "load" : "";
    crash = mode === "crash";
    render(<SemanticProblemSearch problems={problems} catalog={catalog} onCandidates={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "精度向上を準備する（任意）" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(terminated).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "精度向上を準備する（任意）" })).toBeEnabled();
  });
  it.each(["index", "query"])(
    "rejects malformed %s results instead of recommending",
    async (action) => {
      const { onCandidates } = await start();
      malformedAction = action;
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "SQL" } });
      fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
      await screen.findByRole("alert");
      expect(onCandidates).not.toHaveBeenCalledWith(["one", "two"]);
      expect(screen.queryByRole("list", { name: "問題の候補" })).not.toBeInTheDocument();
    },
  );
  it("reports query execution failure and reuses its existing index on a later successful search", async () => {
    const { onCandidates } = await start();
    failureAction = "query";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SQL" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await screen.findByRole("alert");
    failureAction = "";
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await waitFor(() => expect(onCandidates).toHaveBeenLastCalledWith(["one", "two"]));
    expect(posted.mock.calls.filter((call) => call[0].action === "index")).toHaveLength(1);
    await act(async () =>
      deliverLate?.({ request: posted.mock.lastCall?.[0].request, kind: "error", data: "late" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("refuses a search when the host catalog becomes unavailable", async () => {
    const { rerender, onCandidates } = await start();
    rerender(
      <SemanticProblemSearch
        problems={problems}
        catalog={{ ...catalog, error: "offline" }}
        onCandidates={onCandidates}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SQL" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await screen.findByRole("alert");
    expect(posted.mock.calls.filter((call) => call[0].action === "index")).toHaveLength(0);
  });
  it("deletes only this model's saved files and preserves other browser data", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const modelRequest = {
      url: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/revision/model",
    };
    const otherRequest = { url: "https://example.com/another-model" };
    const open = vi
      .fn()
      .mockResolvedValue({ keys: async () => [otherRequest, modelRequest], delete: remove });
    vi.stubGlobal("caches", { keys: async () => ["other-cache", "transformers-cache"], open });
    render(<SemanticProblemSearch problems={problems} catalog={catalog} onCandidates={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "検索用の保存データを削除" }));
    await screen.findByText("検索用の保存データを削除しました。");
    expect(open).toHaveBeenCalledExactlyOnceWith("transformers-cache");
    expect(remove).toHaveBeenCalledExactlyOnceWith(modelRequest);
  });
});

describe("public catalog search without model preparation", () => {
  it("searches without WebGPU or any worker request and clears an empty result", async () => {
    Reflect.deleteProperty(navigator, "gpu");
    const onCandidates = vi.fn();
    render(
      <SemanticProblemSearch problems={problems} catalog={catalog} onCandidates={onCandidates} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "公開概要を学びたい" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await waitFor(() => expect(onCandidates).toHaveBeenLastCalledWith(["one", "two"]));
    expect(posted).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "存在しないZZZテーマ" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    await waitFor(() => expect(onCandidates).toHaveBeenLastCalledWith([]));
    expect(screen.getByRole("status")).toHaveTextContent("見つかりませんでした");
    fireEvent.click(screen.getByRole("button", { name: "目的による絞り込みを解除" }));
    expect(onCandidates).toHaveBeenLastCalledWith(null);
  });
});
