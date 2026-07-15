import { PORTAL_SLOT_NAMES } from "@tenkacloud/portal-plugin-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import { lazy } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-012 Phase 5 PortalPluginSlots wrapper。 loadPluginSlot を mock して slot 無し → null、
 * pending lazy → Suspense fallback、 throw (Error / 非 Error) → PluginErrorBoundary の Alert
 * (#1251 fail-loud console.error) を pin する。 props-builder は空に stub して catalog 非依存に。
 */
const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));
vi.mock("../../src/plugins/loader", () => ({ loadPluginSlot: mockLoad }));
vi.mock("../../src/plugins/props-builder", () => ({
  buildPortalPhases: () => [],
  buildPortalDisruptions: () => [],
  buildPortalCoordination: () => undefined,
  // [#2661] fallback は識別可能な sentinel を返し、 serverEndpoints 優先を区別できるようにする。
  buildPortalEndpointsFromOutputs: () => [
    { slot: "fallback", overridable: false, effectiveUrl: "https://stackoutputs.example" },
  ],
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

afterEach(() => vi.clearAllMocks());

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

  // [#2661] plugin に届く endpoints は「server (override マージ済) 優先、 未取得時のみ stackOutputs
  // fallback」。 この 2 経路で plugin が受け取る effectiveUrl を pin する。
  const endpointRenderer = () =>
    lazy(() =>
      Promise.resolve({
        default: (p: { endpoints: readonly { readonly effectiveUrl?: string }[] }) => (
          <div data-testid="ep">
            {p.endpoints.map((e) => e.effectiveUrl ?? "none").join(",") || "empty"}
          </div>
        ),
      }),
    );

  it("should pass server endpoints (override-merged) to the plugin over the fallback (#2661)", async () => {
    mockLoad.mockImplementation(onlyFirst(endpointRenderer()));
    render(
      <PortalPluginSlots
        {...props}
        serverEndpoints={[
          { slot: "app", overridable: true, effectiveUrl: "https://team.example/app" },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ep")).toHaveTextContent("https://team.example/app"),
    );
  });

  it("should fall back to the stackOutputs-derived endpoints when server endpoints are absent (#2661)", async () => {
    mockLoad.mockImplementation(onlyFirst(endpointRenderer()));
    render(<PortalPluginSlots {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("ep")).toHaveTextContent("https://stackoutputs.example"),
    );
  });
});
