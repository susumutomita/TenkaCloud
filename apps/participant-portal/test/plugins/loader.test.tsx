import type { PortalSlotName } from "@tenkacloud/portal-plugin-sdk";
import { render, screen, waitFor } from "@testing-library/react";
import { Component, type ComponentType, type ReactNode, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * portal plugin loader。 findProblemMetadata を mock して dashboard slot の
 * 宣言有無 / glob 解決可否を制御し、 (1) slot 未宣言 → undefined、 (2) glob 解決済 →
 * memoize された React.lazy、 (3) 宣言済だが file 不在 → erroring lazy (= #1251 fail-loud)
 * を pin する。 erroring lazy は ErrorBoundary 経由で render し console.error を確認する。
 */
const { mockFind } = vi.hoisted(() => ({ mockFind: vi.fn() }));
vi.mock("../../src/data/problems", () => ({ findProblemMetadata: mockFind }));

const { loadPluginSlot, _listDiscoveredPluginKeys, _clearSlotComponentCache } = await import(
  "../../src/plugins/loader"
);

const STATUS = "StatusPanel" as PortalSlotName;

class ErrorBoundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  render() {
    return this.state.errored ? <div>errored</div> : this.props.children;
  }
}

beforeEach(() => {
  mockFind.mockReset();
  _clearSlotComponentCache();
});

describe("loadPluginSlot", () => {
  it("should return undefined for missing metadata / missing slots / undeclared slot", () => {
    mockFind.mockReturnValueOnce(undefined);
    expect(loadPluginSlot("nope", STATUS)).toBeUndefined();
    mockFind.mockReturnValueOnce({});
    expect(loadPluginSlot("nope", STATUS)).toBeUndefined();
    mockFind.mockReturnValueOnce({ dashboardSlots: {} });
    expect(loadPluginSlot("nope", STATUS)).toBeUndefined();
  });

  it("should return a memoized lazy component for a glob-resolved slot", () => {
    mockFind.mockReturnValue({ dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" } });
    const a = loadPluginSlot("microservice-migration-battle", STATUS);
    const b = loadPluginSlot("microservice-migration-battle", STATUS);
    expect(a).toBeDefined();
    // same (problemId, slot) → 同一 component identity (Suspense flash 抑止の cache)。
    expect(a).toBe(b);
  });

  it("should return an erroring lazy for a declared-but-unresolved slot and fail loud on render", async () => {
    mockFind.mockReturnValue({ dashboardSlots: { StatusPanel: "portal/DoesNotExist.tsx" } });
    const Comp = loadPluginSlot("ghost-problem", STATUS);
    expect(Comp).toBeDefined();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const C = Comp as unknown as ComponentType;
    render(
      <ErrorBoundary>
        <Suspense fallback={<div>loading</div>}>
          <C />
        </Suspense>
      </ErrorBoundary>,
    );
    await waitFor(() => expect(screen.getByText("errored")).toBeInTheDocument());
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes("unresolved slot"))).toBe(
      true,
    );
    errSpy.mockRestore();
  });

  it("should import the real plugin chunk when the slot resolves (covers the glob loader)", async () => {
    mockFind.mockReturnValue({ dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" } });
    const Comp = loadPluginSlot("microservice-migration-battle", STATUS);
    expect(Comp).toBeDefined();
    // suppress any render-time warnings from the real component.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const C = Comp as unknown as ComponentType<Record<string, unknown>>;
    render(
      <ErrorBoundary>
        <Suspense fallback={<div>loading-real</div>}>
          <C />
        </Suspense>
      </ErrorBoundary>,
    );
    // import が解決 (= glob loader 実行) すると fallback が消える (rendered or errored)。
    await waitFor(() => expect(screen.queryByText("loading-real")).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });

  it("should expose the discovered glob keys and a cache reset for tests", () => {
    const keys = _listDiscoveredPluginKeys();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.some((k) => k.endsWith("/portal/StatusPanel.tsx"))).toBe(true);

    // cache reset 後は同 (problemId, slot) でも新しい component identity が返る。
    mockFind.mockReturnValue({ dashboardSlots: { StatusPanel: "portal/StatusPanel.tsx" } });
    const first = loadPluginSlot("microservice-migration-battle", STATUS);
    _clearSlotComponentCache();
    const second = loadPluginSlot("microservice-migration-battle", STATUS);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });
});
