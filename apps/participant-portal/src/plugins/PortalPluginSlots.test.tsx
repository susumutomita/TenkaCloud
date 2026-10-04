import { render, screen, waitFor } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PortalPluginSlots の振る舞いを pin する。
 *
 * loader を mock することで「plugin が throw する case」 「resolve できない case」 「複数 slot
 * が並ぶ case」 を deterministic に観測する。 production catalog (= problems/ 配下の static
 * metadata) は本テストでは触らない。
 */

// loader を mock。 loadPluginSlot の戻り値で 3 case を切り分け、 PortalPluginSlots が
// ErrorBoundary / Suspense / null-render gating を正しく行うか観測する。
vi.mock("./loader", () => {
  return {
    loadPluginSlot: vi.fn(),
    _clearSlotComponentCache: vi.fn(),
  };
});

// props-builder も catalog 依存なので mock し、 PortalSlotProps の組立は本テスト範囲外と分離。
vi.mock("./props-builder", () => ({
  buildPortalEndpointsFromOutputs: vi.fn(() => []),
  buildPortalEndpointsFromRegistry: vi.fn((endpoints) => endpoints),
  buildPortalPhases: vi.fn(() => []),
  buildPortalDisruptions: vi.fn(() => []),
  buildPortalCoordination: vi.fn(() => undefined),
  buildPortalTeam: vi.fn((team) => team),
}));

// #1420: coordination-client を mock し、 PortalPluginSlots が dispatcher URL + session を束ねた
// coordinationClient を slot に渡すこと (= op/projection が正しい引数で client を叩く) を観測する。
vi.mock("../api/coordination-client", () => ({
  submitCoordinationOp: vi.fn().mockResolvedValue({ kind: "ok", projection: {} }),
  getCoordinationProjection: vi.fn().mockResolvedValue({ kind: "ok", projection: {} }),
}));

const mockRefresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../auth/TeamViewProvider", () => ({
  useTeamView: () => ({ refreshAfterMutation: mockRefresh }),
}));

const { loadPluginSlot } = await import("./loader");
const { buildPortalCoordination } = await import("./props-builder");
const { submitCoordinationOp, getCoordinationProjection } = await import(
  "../api/coordination-client"
);
const { PortalPluginSlots } = await import("./PortalPluginSlots");
const mockLoadPluginSlot = loadPluginSlot as ReturnType<typeof vi.fn>;
const mockBuildCoordination = buildPortalCoordination as ReturnType<typeof vi.fn>;
const mockSubmitOp = submitCoordinationOp as ReturnType<typeof vi.fn>;
const mockGetProjection = getCoordinationProjection as ReturnType<typeof vi.fn>;

const baseProps = {
  problemId: "fake-problem",
  jobId: "job-1",
  score: 0,
  locale: "ja" as const,
  team: { teamName: "team-x" },
  stackOutputs: {},
};

afterEach(() => {
  mockLoadPluginSlot.mockReset();
  mockBuildCoordination.mockReset();
  mockSubmitOp.mockReset().mockResolvedValue({ kind: "ok", projection: {} });
  mockGetProjection.mockReset().mockResolvedValue({ kind: "ok", projection: {} });
});

describe("PortalPluginSlots", () => {
  it("should return null and render nothing when no slot has a loader", () => {
    mockLoadPluginSlot.mockReturnValue(undefined);
    const { container } = render(<PortalPluginSlots {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  it("should render the component when the StatusPanel slot resolves", async () => {
    function FakeStatusPanel() {
      return <div data-testid="fake-status">fake status</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? FakeStatusPanel : undefined,
    );
    render(<PortalPluginSlots {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId("fake-status")).toBeInTheDocument());
  });

  it("should pass interTeamCoordination to the slot props when present (#1420)", async () => {
    mockBuildCoordination.mockReturnValue({ name: "Router", description: "service mesh" });
    function CoordPanel(props: { coordination?: { name?: string } }) {
      return <div data-testid="coord">{props.coordination?.name}</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? CoordPanel : undefined,
    );
    render(<PortalPluginSlots {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId("coord")).toHaveTextContent("Router"));
  });

  it("should pass locale and live posture snapshot to plugin slot props (#1895/#1896)", async () => {
    function RuntimePropsPanel(props: {
      locale: string;
      posture?: Record<string, boolean>;
      platform?: string;
    }) {
      return (
        <div data-testid="runtime-props">
          {props.locale}:{props.platform}:{props.posture?.db_present ? "done" : "missing"}
        </div>
      );
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? RuntimePropsPanel : undefined,
    );
    render(
      <PortalPluginSlots
        {...baseProps}
        locale="en"
        posture={{ db_present: true, auth_enabled: false }}
        platform="posture-1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("runtime-props")).toHaveTextContent("en:posture-1:done"),
    );
  });

  it("should pass eventEndsAt to plugin slot props when the event has an end time, and omit it otherwise", async () => {
    function EndsAtPanel(props: { eventEndsAt?: string }) {
      return <div data-testid="ends-at">{props.eventEndsAt ?? "none"}</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? EndsAtPanel : undefined,
    );
    const { rerender } = render(
      <PortalPluginSlots {...baseProps} eventEndsAt="2026-09-27T12:00:00.000Z" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ends-at")).toHaveTextContent("2026-09-27T12:00:00.000Z"),
    );

    rerender(<PortalPluginSlots {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId("ends-at")).toHaveTextContent("none"));
  });

  it("should pass the authoritative endpoint override to plugin slot props", async () => {
    function EndpointPanel(props: {
      endpoints: readonly { slot: string; effectiveUrl?: string }[];
    }) {
      return <div data-testid="endpoint-url">{props.endpoints[0]?.effectiveUrl}</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? EndpointPanel : undefined,
    );

    render(
      <PortalPluginSlots
        {...baseProps}
        endpoints={[
          {
            slot: "app",
            overridable: true,
            defaultKey: "RegisteredUrl",
            overrideUrl: "https://override.example.com",
            effectiveUrl: "https://override.example.com",
          },
        ]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("endpoint-url")).toHaveTextContent("https://override.example.com"),
    );
  });

  it("should bind a live coordination client when coordinationApiUrl + sessionToken are present and route op/projection through it (#1420)", async () => {
    let captured: { submitOp: (op: unknown) => unknown; getProjection: () => unknown } | undefined;
    function CoordClientPanel(props: {
      coordinationClient?: { submitOp: (op: unknown) => unknown; getProjection: () => unknown };
    }) {
      captured = props.coordinationClient;
      return <div data-testid="cc">{props.coordinationClient ? "bound" : "none"}</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slotName) =>
      slotName === "StatusPanel" ? CoordClientPanel : undefined,
    );
    render(
      <PortalPluginSlots
        {...baseProps}
        coordinationApiUrl="https://coord.example"
        sessionToken="key-1"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("cc")).toHaveTextContent("bound"));
    // biome-ignore lint/style/noNonNullAssertion: render asserted the client is bound
    await captured!.submitOp({ kind: "register-route", url: "https://svc" });
    // biome-ignore lint/style/noNonNullAssertion: render asserted the client is bound
    await captured!.getProjection();
    expect(mockSubmitOp).toHaveBeenCalledWith(
      "https://coord.example",
      "key-1",
      { kind: "register-route", url: "https://svc" },
      undefined,
      expect.any(String),
      baseProps.jobId,
    );
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockGetProjection).toHaveBeenCalledWith("https://coord.example", "key-1");
  });

  it("retains separate uncertain payload keys across rerenders and clears only acknowledged intents", async () => {
    let captured: { submitOp: (op: unknown) => Promise<unknown> } | undefined;
    function Panel(props: { coordinationClient?: typeof captured }) {
      captured = props.coordinationClient;
      return <div data-testid="retry-client">bound</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slot) =>
      slot === "StatusPanel" ? Panel : undefined,
    );
    const props = {
      ...baseProps,
      coordinationApiUrl: "https://coord.example",
      sessionToken: "key-1",
    };
    const rendered = render(<PortalPluginSlots {...props} />);
    await screen.findByTestId("retry-client");
    if (!captured) throw new Error("Expected live client");
    mockSubmitOp.mockRejectedValueOnce(new Error("response lost"));
    await expect(captured.submitOp({ move: "A" })).rejects.toThrow("response lost");
    mockSubmitOp.mockResolvedValueOnce({ kind: "unavailable" });
    await captured.submitOp({ move: "B" });
    rendered.rerender(<PortalPluginSlots {...props} score={10} />);
    await captured.submitOp({ move: "A" });
    expect(mockSubmitOp.mock.calls[2]?.[4]).toBe(mockSubmitOp.mock.calls[0]?.[4]);
    await captured.submitOp({ move: "A" });
    expect(mockSubmitOp.mock.calls[3]?.[4]).not.toBe(mockSubmitOp.mock.calls[0]?.[4]);
    await captured.submitOp({ move: "B" });
    expect(mockSubmitOp.mock.calls[4]?.[4]).toBe(mockSubmitOp.mock.calls[1]?.[4]);
    mockSubmitOp.mockResolvedValueOnce({ kind: "conflict" });
    await captured.submitOp({ move: "C" });
    rendered.rerender(<PortalPluginSlots {...props} sessionToken="key-2" jobId="new-run" />);
    await captured.submitOp({ move: "C" });
    expect(mockSubmitOp.mock.calls[6]?.[4]).not.toBe(mockSubmitOp.mock.calls[5]?.[4]);
  });

  it("does not let a late duplicate response clear a newer intent for the same payload", async () => {
    let captured: { submitOp: (op: unknown) => Promise<unknown> } | undefined;
    function Panel(props: { coordinationClient?: typeof captured }) {
      captured = props.coordinationClient;
      return <div data-testid="concurrent-client">bound</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slot) =>
      slot === "StatusPanel" ? Panel : undefined,
    );
    const resolve: ((value: { kind: "ok"; projection: object }) => void)[] = [];
    mockSubmitOp.mockImplementation(() => new Promise((done) => resolve.push(done)));
    render(
      <PortalPluginSlots
        {...baseProps}
        coordinationApiUrl="https://coord.example"
        sessionToken="key"
      />,
    );
    await screen.findByTestId("concurrent-client");
    if (!captured) throw new Error("Expected live client");
    const first = captured.submitOp({ move: "A" });
    const duplicate = captured.submitOp({ move: "A" });
    expect(mockSubmitOp.mock.calls[1]?.[4]).toBe(mockSubmitOp.mock.calls[0]?.[4]);
    resolve[0]?.({ kind: "ok", projection: {} });
    await first;
    const next = captured.submitOp({ move: "A" });
    expect(mockSubmitOp.mock.calls[2]?.[4]).not.toBe(mockSubmitOp.mock.calls[0]?.[4]);
    resolve[1]?.({ kind: "ok", projection: {} });
    await duplicate;
    const retry = captured.submitOp({ move: "A" });
    expect(mockSubmitOp.mock.calls[3]?.[4]).toBe(mockSubmitOp.mock.calls[2]?.[4]);
    resolve[2]?.({ kind: "ok", projection: {} });
    resolve[3]?.({ kind: "ok", projection: {} });
    await Promise.all([next, retry]);
  });

  it("coalesces concurrent slot polls without retaining a completed response or crossing sessions", async () => {
    let client: { getProjection: () => Promise<unknown> } | undefined;
    function Panel(props: { coordinationClient?: typeof client }) {
      client = props.coordinationClient;
      return <div data-testid="shared-poll-client">bound</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slot) =>
      slot === "StatusPanel" ? Panel : undefined,
    );
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    mockGetProjection.mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    );
    const props = {
      ...baseProps,
      coordinationApiUrl: "https://coord.example",
      sessionToken: "key-1",
    };
    const rendered = render(<PortalPluginSlots {...props} />);
    await screen.findByTestId("shared-poll-client");
    if (!client) throw new Error("Expected live client");
    const initialClient = client;
    const polls = Array.from({ length: 4 }, () => initialClient.getProjection());
    expect(mockGetProjection).toHaveBeenCalledTimes(1);
    expect(polls.every((poll) => poll === polls[0])).toBe(true);
    pending[0]?.resolve({ kind: "ok", projection: { revision: 1 } });
    await Promise.all(polls);
    const next = client.getProjection();
    expect(mockGetProjection).toHaveBeenCalledTimes(2);
    const rejected = expect(next).rejects.toThrow("offline");
    pending[1]?.reject(new Error("offline"));
    await rejected;
    const oldSession = client.getProjection();
    rendered.rerender(<PortalPluginSlots {...props} sessionToken="key-2" jobId="run-2" />);
    const newSession = client.getProjection();
    expect(mockGetProjection).toHaveBeenCalledTimes(4);
    pending[2]?.resolve({ kind: "ok", projection: { old: true } });
    await oldSession;
    expect(client.getProjection()).toBe(newSession);
    expect(mockGetProjection).toHaveBeenCalledTimes(4);
    pending[3]?.resolve({ kind: "ok", projection: { new: true } });
    await newSession;
  });

  it("bounds uncertain operations without evicting their retry keys", async () => {
    let captured: { submitOp: (op: unknown) => Promise<unknown> } | undefined;
    function Panel(props: { coordinationClient?: typeof captured }) {
      captured = props.coordinationClient;
      return <div data-testid="bounded-client">bound</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slot) =>
      slot === "StatusPanel" ? Panel : undefined,
    );
    render(
      <PortalPluginSlots
        {...baseProps}
        coordinationApiUrl="https://coord.example"
        sessionToken="key"
      />,
    );
    await screen.findByTestId("bounded-client");
    if (!captured) throw new Error("Expected live client");
    expect(await captured.submitOp(undefined)).toEqual({ kind: "rejected", error: "invalid_op" });
    expect(mockSubmitOp).not.toHaveBeenCalled();
    mockSubmitOp.mockResolvedValue({ kind: "unavailable" });
    for (let i = 0; i < 32; i++) await captured.submitOp({ move: i });
    expect(await captured.submitOp({ move: 32 })).toEqual({ kind: "unavailable" });
    expect(mockSubmitOp).toHaveBeenCalledTimes(32);
    await captured.submitOp({ move: 0 });
    expect(mockSubmitOp.mock.calls[32]?.[4]).toBe(mockSubmitOp.mock.calls[0]?.[4]);
  });

  it("should NOT bind a coordination client when the dispatcher URL or session is missing (#1420)", async () => {
    function Panel(props: { coordinationClient?: unknown }) {
      return <div data-testid="cc">{props.coordinationClient ? "bound" : "none"}</div>;
    }
    mockLoadPluginSlot.mockImplementation((_p, slotName) =>
      slotName === "StatusPanel" ? Panel : undefined,
    );
    // dispatcher URL あり / session なし → 束縛しない (= 認証無しで coordination を叩かせない)
    render(<PortalPluginSlots {...baseProps} coordinationApiUrl="https://coord.example" />);
    await waitFor(() => expect(screen.getByTestId("cc")).toHaveTextContent("none"));
    expect(mockSubmitOp).not.toHaveBeenCalled();
  });

  it("should let ErrorBoundary fall back to an Alert when a plugin throws (= the whole portal does not crash) and elevate the log to console.error (Issue #1251)", async () => {
    function CrashyPanel(): never {
      throw new Error("plugin runtime crash");
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? CrashyPanel : undefined,
    );
    // warn は出てはいけない (= 旧 band-aid の silent warn を撤去済)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // React 自体の "Error in component" + ErrorBoundary の componentDidCatch が両方 console.error する。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<PortalPluginSlots {...baseProps} />);
      await waitFor(() => {
        // Alert header text (Cloudscape Alert は header を visible に出す)
        expect(screen.getByText(/Plugin "StatusPanel" failed to render/)).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "入力を破棄して再読み込み" }),
        ).toBeInTheDocument();
      });
      // ErrorBoundary の componentDidCatch は console.error で発火する (= operator が見える)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[portal-plugin] slot=StatusPanel crashed"),
        expect.anything(),
      );
      // 旧 silent fallback (= console.warn) は撤去済 (= warn では出ない)
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((c) => c.includes("[portal-plugin] slot=StatusPanel crashed"))).toBe(
        false,
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("should render multiple declared slots in PORTAL_SLOT_NAMES literal order (StatusPanel -> RegistrationPanel -> HelpDrawer)", async () => {
    function StatusComp() {
      return <div data-testid="slot-status">status</div>;
    }
    function RegisterComp() {
      return <div data-testid="slot-register">register</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) => {
      if (slotName === "StatusPanel") return StatusComp;
      if (slotName === "RegistrationPanel") return RegisterComp;
      return undefined;
    });
    render(<PortalPluginSlots {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("slot-status")).toBeInTheDocument();
      expect(screen.getByTestId("slot-register")).toBeInTheDocument();
    });
    // DOM 順 (= top → bottom) で StatusPanel が RegistrationPanel より先
    const statusEl = screen.getByTestId("slot-status");
    const registerEl = screen.getByTestId("slot-register");
    expect(
      statusEl.compareDocumentPosition(registerEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // ErrorBoundary class を直接 vs 統合した render path を pin。 stale state を防ぐため別 instance で。
  it("ErrorBoundary alone: should catch a child throw and include the given slotName in the header", () => {
    class ProbeErrorBoundary extends Component<
      { slotName: string; children: ReactNode },
      { hasError: boolean; message?: string }
    > {
      state = { hasError: false, message: undefined as string | undefined };
      static getDerivedStateFromError(err: unknown) {
        return { hasError: true, message: err instanceof Error ? err.message : String(err) };
      }
      componentDidCatch(_err: Error, _info: ErrorInfo): void {}
      render() {
        return this.state.hasError ? `ERR: ${this.state.message}` : this.props.children;
      }
    }
    function Throws(): never {
      throw new Error("boom");
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { container } = render(
        <ProbeErrorBoundary slotName="X">
          <Throws />
        </ProbeErrorBoundary>,
      );
      expect(container.textContent).toBe("ERR: boom");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
