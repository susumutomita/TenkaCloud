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
  Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: { data: object }) => void) | null = null;
      onerror = null;
      terminate = terminated;
      postMessage(request: { action: string; request: number }) {
        posted(request);
        if (holdIndex && request.action === "index") return;
        const indexData = { elapsedMs: 1, vectors: problems.map((p) => ({ id: p.id, vector })) };
        const queryData = request.action === "query" ? { elapsedMs: 1, vector } : { elapsedMs: 1 };
        const data = request.action === "index" ? indexData : queryData;
        queueMicrotask(() =>
          this.onmessage?.({ data: { request: request.request, kind: "result", data } }),
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
  fireEvent.click(screen.getByRole("button", { name: "検索を準備する" }));
  await screen.findByRole("textbox");
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
    expect(screen.getByRole("button", { name: "検索を準備する" })).toBeEnabled();
    holdIndex = false;
    fireEvent.click(screen.getByRole("button", { name: "検索を準備する" }));
    await screen.findByRole("textbox");
  });
  it("clears results when hard filters change during a pending request", async () => {
    const { rerender, onCandidates } = await start();
    holdIndex = true;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "調査" } });
    fireEvent.click(screen.getByRole("button", { name: "候補を探す" }));
    rerender(<SemanticProblemSearch problems={[]} catalog={catalog} onCandidates={onCandidates} />);
    await waitFor(() => expect(terminated).toHaveBeenCalled());
    expect(onCandidates).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "検索を準備する" })).toBeEnabled();
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
    expect(screen.getByRole("button", { name: "検索を準備する" })).toBeEnabled();
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
