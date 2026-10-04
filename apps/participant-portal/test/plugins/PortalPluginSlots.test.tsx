import {
  PORTAL_SLOT_NAMES,
  type PortalCoordinationClient,
  type PortalSlotProps,
} from "@tenkacloud/portal-plugin-sdk";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * portal plugin PortalPluginSlots wrapper。 loadPluginSlot を mock して slot 無し → null、
 * pending lazy → Suspense fallback、 throw (Error / 非 Error) → PluginErrorBoundary の Alert
 * (#1251 fail-loud console.error) を pin する。 props-builder は空に stub して catalog 非依存に。
 */
const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));
vi.mock("../../src/plugins/loader", () => ({ loadPluginSlot: mockLoad }));
vi.mock("../../src/plugins/props-builder", () => ({
  buildPortalPhases: () => [],
  buildPortalDisruptions: () => [],
  buildPortalCoordination: () => undefined,
  buildPortalEndpointsFromOutputs: () => [],
  buildPortalEndpointsFromRegistry: (endpoints: unknown) => endpoints,
  buildPortalTeam: (team: unknown) => team,
}));

const { PortalPluginSlots } = await import("../../src/plugins/PortalPluginSlots");

const SLOT = PORTAL_SLOT_NAMES[0];
const props = {
  problemId: "p1",
  jobId: "job-1",
  score: 0,
  locale: "ja" as const,
  team: { teamName: "Alpha" },
  stackOutputs: {},
};
// 指定 slot だけ与えた lazy を返し、 他は undefined。
const onlyFirst = (comp: ReturnType<typeof lazy>) => (_: string, slot: string) =>
  slot === SLOT ? comp : undefined;

function pendingOperationPanel(clients: PortalCoordinationClient[], op: unknown) {
  return function OperationPanel({ coordinationClient }: PortalSlotProps) {
    const [status, setStatus] = useState("ready");
    if (coordinationClient) clients.push(coordinationClient);
    return (
      <>
        <output aria-label="operation state">{status}</output>
        <button
          type="button"
          onClick={() => {
            setStatus("pending");
            void coordinationClient?.submitOp(op).then((result) => setStatus(result.kind));
          }}
        >
          Submit move
        </button>
      </>
    );
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("PortalPluginSlots", () => {
  it("should render nothing when no slot resolves", () => {
    mockLoad.mockReturnValue(undefined);
    const { container } = render(<PortalPluginSlots {...props} />);
    expect(container.textContent).toBe("");
  });

  it("should show the Suspense loading fallback while a plugin chunk is pending", () => {
    const pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
    mockLoad.mockImplementation(onlyFirst(pending));
    render(<PortalPluginSlots {...props} />);
    expect(screen.getByText(new RegExp(`Loading plugin: ${SLOT}`))).toBeInTheDocument();
  });

  it("should degrade to a warning Alert when a plugin throws an Error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = lazy(() => Promise.reject(new Error("plugin boom")));
    mockLoad.mockImplementation(onlyFirst(boom));
    render(<PortalPluginSlots {...props} />);
    await waitFor(() => expect(screen.getByText("plugin boom")).toBeInTheDocument());
    // #1251: crash を console.error に昇格。
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("crashed"))).toBe(true);
    errSpy.mockRestore();
  });

  it("should stringify a non-Error plugin throwable in the Alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = lazy(() => Promise.reject("plugin-string-failure"));
    mockLoad.mockImplementation(onlyFirst(boom));
    render(<PortalPluginSlots {...props} />);
    await waitFor(() => expect(screen.getByText("plugin-string-failure")).toBeInTheDocument());
  });

  it.each(["01K00000000000000000000004", "local-job-1"])(
    "keeps uncertain operations pinned to their original run across polling and resets (%s)",
    async (runId) => {
      const clients: PortalCoordinationClient[] = [];
      const capture = lazy(async () => ({
        default: ({ coordinationClient }: PortalSlotProps) => {
          if (coordinationClient) clients.push(coordinationClient);
          return <div>Battle ready</div>;
        },
      }));
      mockLoad.mockImplementation(onlyFirst(capture));
      const fetch = vi.fn().mockResolvedValue({ status: 503 });
      vi.stubGlobal("fetch", fetch);
      const active = {
        ...props,
        jobId: runId,
        coordinationApiUrl: "https://coord.example.com",
        sessionToken: "team-key",
      };
      const { rerender } = render(<PortalPluginSlots {...active} />);
      await screen.findByText("Battle ready");
      const original = clients.at(-1);
      if (!original) throw new Error("Coordination client is missing");
      const op = { kind: "ready" };
      expect(await original.submitOp(op)).toEqual({ kind: "unavailable" });
      rerender(<PortalPluginSlots {...active} score={1} />);
      expect(clients.at(-1)).toBe(original);
      expect(await original.submitOp(op)).toEqual({ kind: "unavailable" });
      const first = fetch.mock.calls[0]?.[1];
      expect(first.body).toBe(JSON.stringify({ op, runId }));
      expect(fetch.mock.calls[1]?.[1]).toEqual(first);

      const nextRunId = "01K00000000000000000000005";
      rerender(<PortalPluginSlots {...active} jobId={nextRunId} />);
      const next = clients.at(-1);
      if (!next || next === original) throw new Error("Reset must create a new run client");
      await next.submitOp(op);
      const rotated = fetch.mock.calls[2]?.[1];
      expect(rotated.body).toBe(JSON.stringify({ op, runId: nextRunId }));
      expect(rotated.headers["Idempotency-Key"]).not.toBe(first.headers["Idempotency-Key"]);
      await original.submitOp(op);
      expect(fetch.mock.calls[3]?.[1]).toEqual(first);
    },
  );

  it("ends stale-run retries after the server rejects rotation and uses a fresh key for the next run", async () => {
    const clients: PortalCoordinationClient[] = [];
    const capture = lazy(async () => ({
      default: ({ coordinationClient }: PortalSlotProps) => {
        if (coordinationClient) clients.push(coordinationClient);
        return <div>Battle ready</div>;
      },
    }));
    mockLoad.mockImplementation(onlyFirst(capture));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({
        status: 409,
        json: async () => ({ error: "coordination_run_changed" }),
      })
      .mockResolvedValue({ status: 200, json: async () => ({ projection: { ready: true } }) });
    vi.stubGlobal("fetch", fetch);
    const active = {
      ...props,
      jobId: "01K00000000000000000000004",
      coordinationApiUrl: "https://coord.example.com",
      sessionToken: "team-key",
    };
    const { rerender } = render(<PortalPluginSlots {...active} />);
    await screen.findByText("Battle ready");
    const original = clients.at(-1);
    if (!original) throw new Error("Coordination client is missing");
    const op = { kind: "ready" };
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await original.submitOp(op);
      outcomes.push(result);
      if (result.kind !== "unavailable" && result.kind !== "conflict") break;
    }
    expect(outcomes).toEqual([
      { kind: "unavailable" },
      { kind: "rejected", error: "coordination_run_changed" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0]?.[1];
    expect(first.body).toBe(JSON.stringify({ op, runId: active.jobId }));
    expect(fetch.mock.calls[1]?.[1]).toEqual(first);

    const nextRunId = "01K00000000000000000000005";
    rerender(<PortalPluginSlots {...active} jobId={nextRunId} />);
    const next = clients.at(-1);
    if (!next || next === original) throw new Error("Reset must create a new run client");
    expect(await next.submitOp(op)).toEqual({ kind: "ok", projection: { ready: true } });
    expect(fetch).toHaveBeenCalledTimes(3);
    const rotated = fetch.mock.calls[2]?.[1];
    expect(rotated.body).toBe(JSON.stringify({ op, runId: nextRunId }));
    expect(rotated.headers["Idempotency-Key"]).not.toBe(first.headers["Idempotency-Key"]);
  });

  it.each(["default", "01K00000000000000000000004"])(
    "pins a cloud operation to %s and clears slot state when only the shared run rotates",
    async (coordinationRunId) => {
      // Only catalog/slot loading is stubbed; the real client serializes runId + idempotency key.
      const clients: PortalCoordinationClient[] = [];
      const op = { kind: "ready" };
      const capture = lazy(async () => ({
        default: pendingOperationPanel(clients, op),
      }));
      mockLoad.mockImplementation(onlyFirst(capture));
      let resolvePending: ((response: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        resolvePending = resolve;
      });
      const fetch = vi.fn().mockResolvedValue({ status: 503 }).mockReturnValueOnce(pending);
      vi.stubGlobal("fetch", fetch);
      const active = {
        ...props,
        jobId: "unchanged-cloud-deployment",
        coordinationRunId,
        coordinationApiUrl: "https://coord.example.com",
        sessionToken: "team-key",
      };
      const { rerender } = render(<PortalPluginSlots {...active} />);
      fireEvent.click(await screen.findByRole("button", { name: "Submit move" }));
      expect(screen.getByLabelText("operation state")).toHaveTextContent("pending");
      const original = clients.at(-1);
      if (!original) throw new Error("Coordination client is missing");
      const first = fetch.mock.calls[0]?.[1];
      expect(first.body).toBe(JSON.stringify({ op, runId: coordinationRunId }));
      rerender(<PortalPluginSlots {...active} score={1} />);
      expect(clients.at(-1)).toBe(original);
      expect(screen.getByLabelText("operation state")).toHaveTextContent("pending");

      const nextRunId = "01K00000000000000000000005";
      rerender(<PortalPluginSlots {...active} coordinationRunId={nextRunId} />);
      expect(screen.getByLabelText("operation state")).toHaveTextContent("ready");
      const next = clients.at(-1);
      if (!next || next === original) throw new Error("Reset must create a new run client");
      await next.submitOp(op);
      expect(fetch.mock.calls[1]?.[1].body).toBe(JSON.stringify({ op, runId: nextRunId }));
      expect(fetch.mock.calls[1]?.[1].headers["Idempotency-Key"]).not.toBe(
        first.headers["Idempotency-Key"],
      );
      // A retained retry closure must never move the old uncertain intent to the new run.
      await original.submitOp(op);
      expect(fetch.mock.calls[2]?.[1]).toEqual(first);
      await act(async () => {
        resolvePending?.(Response.json({ projection: { oldRun: true } }));
        await pending;
      });
      expect(screen.getByLabelText("operation state")).toHaveTextContent("ready");
    },
  );
});
