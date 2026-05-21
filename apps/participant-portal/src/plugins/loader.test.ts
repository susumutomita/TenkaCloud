import { afterEach, describe, expect, it } from "vitest";
import { _clearSlotComponentCache, _listDiscoveredPluginKeys, loadPluginSlot } from "./loader";

afterEach(() => {
  _clearSlotComponentCache();
});

/**
 * ADR-012 Phase 5: plugin loader が Vite glob で問題 dir 配下の portal tsx を
 * discover できることと、 metadata.dashboard.slots → component の lookup が正しいことを pin。
 */
describe("plugin loader (ADR-012 Phase 5)", () => {
  it("should discover the 2 files under microservice-migration-battle/portal/ via Vite glob", () => {
    const keys = _listDiscoveredPluginKeys();
    expect(
      keys.some((k) => k.endsWith("/microservice-migration-battle/portal/StatusPanel.tsx")),
    ).toBe(true);
    expect(
      keys.some((k) => k.endsWith("/microservice-migration-battle/portal/RegistrationPanel.tsx")),
    ).toBe(true);
  });

  it("should return React.lazy for StatusPanel declared in dashboard.slots", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    expect(Comp).toBeDefined();
    // React.lazy は LazyExoticComponent (= 内部に `$$typeof` / `_payload` を持つ)
    expect(typeof Comp).toBe("object");
  });

  it("should return React.lazy for RegistrationPanel declared in dashboard.slots as well", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "RegistrationPanel");
    expect(Comp).toBeDefined();
  });

  it("should return undefined for HelpDrawer when the slot is not declared in metadata", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "HelpDrawer");
    expect(Comp).toBeUndefined();
  });

  it("should return undefined for all slots when the problem (hello-world) has no dashboard.slots", () => {
    expect(loadPluginSlot("hello-world", "StatusPanel")).toBeUndefined();
    expect(loadPluginSlot("hello-world", "RegistrationPanel")).toBeUndefined();
    expect(loadPluginSlot("hello-world", "HelpDrawer")).toBeUndefined();
  });

  it("should return undefined for a non-existent problemId", () => {
    expect(loadPluginSlot("does-not-exist", "StatusPanel")).toBeUndefined();
  });

  it("should return the same LazyExoticComponent instance when called twice for the same (problemId, slotName) (= memoize)", () => {
    const a = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    const b = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // memoize されていなければ React.lazy(loader) で別 instance になる (= Suspense identity 不安定)
    expect(a).toBe(b);
  });
});
