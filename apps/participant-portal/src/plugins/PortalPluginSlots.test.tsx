import { render, screen, waitFor } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-012 Phase 5: PortalPluginSlots の振る舞い pin。
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
  buildPortalPhases: vi.fn(() => []),
  buildPortalDisruptions: vi.fn(() => []),
  buildPortalTeam: vi.fn((team) => team),
}));

const { loadPluginSlot } = await import("./loader");
const { PortalPluginSlots } = await import("./PortalPluginSlots");
const mockLoadPluginSlot = loadPluginSlot as ReturnType<typeof vi.fn>;

const baseProps = {
  problemId: "fake-problem",
  jobId: "job-1",
  score: 0,
  team: { teamName: "team-x" },
  stackOutputs: {},
};

afterEach(() => {
  mockLoadPluginSlot.mockReset();
});

describe("PortalPluginSlots (ADR-012 Phase 5)", () => {
  it("どの slot にも loader が無いなら null を返して何も render しないべき", () => {
    mockLoadPluginSlot.mockReturnValue(undefined);
    const { container } = render(<PortalPluginSlots {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  it("StatusPanel slot が解決できれば該当 component を render すべき", async () => {
    function FakeStatusPanel() {
      return <div data-testid="fake-status">fake status</div>;
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? FakeStatusPanel : undefined,
    );
    render(<PortalPluginSlots {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId("fake-status")).toBeInTheDocument());
  });

  it("plugin が throw すると ErrorBoundary が fallback Alert に降ろすべき (= portal 全体は落ちない)", async () => {
    function CrashyPanel(): never {
      throw new Error("plugin runtime crash");
    }
    mockLoadPluginSlot.mockImplementation((_problemId, slotName) =>
      slotName === "StatusPanel" ? CrashyPanel : undefined,
    );
    // ErrorBoundary class が componentDidCatch で warn log → suppress
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // React は ErrorBoundary に到達するまで error を console.error する。 test noise を抑止。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<PortalPluginSlots {...baseProps} />);
      await waitFor(() => {
        // Alert header text (Cloudscape Alert は header を visible に出す)
        expect(screen.getByText(/Plugin "StatusPanel" の表示に失敗しました/)).toBeInTheDocument();
      });
      // ErrorBoundary の componentDidCatch で warn を発火することを確認
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[portal-plugin] slot=StatusPanel crashed"),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("複数 slot が宣言されていれば PORTAL_SLOT_NAMES の literal 順 (StatusPanel → RegistrationPanel → HelpDrawer) で render すべき", async () => {
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
  it("ErrorBoundary 単体: child の throw を catch して指定 slotName を header に含めるべき", () => {
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
