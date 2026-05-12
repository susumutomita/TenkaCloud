import { describe, expect, it } from "vitest";
import { _listDiscoveredPluginKeys, loadPluginSlot } from "./loader";

/**
 * ADR-012 Phase 5: plugin loader が Vite glob で問題 dir 配下の portal tsx を
 * discover できることと、 metadata.dashboard.slots → component の lookup が正しいことを pin。
 */
describe("plugin loader (ADR-012 Phase 5)", () => {
  it("Vite glob で microservice-migration-battle/portal/ の 2 file を discover すべき", () => {
    const keys = _listDiscoveredPluginKeys();
    expect(
      keys.some((k) => k.endsWith("/microservice-migration-battle/portal/StatusPanel.tsx")),
    ).toBe(true);
    expect(
      keys.some((k) => k.endsWith("/microservice-migration-battle/portal/RegistrationPanel.tsx")),
    ).toBe(true);
  });

  it("dashboard.slots 宣言済の StatusPanel は React.lazy を返すべき", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    expect(Comp).toBeDefined();
    // React.lazy は LazyExoticComponent (= 内部に `$$typeof` / `_payload` を持つ)
    expect(typeof Comp).toBe("object");
  });

  it("dashboard.slots 宣言済の RegistrationPanel も React.lazy を返すべき", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "RegistrationPanel");
    expect(Comp).toBeDefined();
  });

  it("metadata に slot 宣言が無い HelpDrawer は undefined を返すべき", () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "HelpDrawer");
    expect(Comp).toBeUndefined();
  });

  it("dashboard.slots を持たない問題 (hello-world) は全 slot で undefined を返すべき", () => {
    expect(loadPluginSlot("hello-world", "StatusPanel")).toBeUndefined();
    expect(loadPluginSlot("hello-world", "RegistrationPanel")).toBeUndefined();
    expect(loadPluginSlot("hello-world", "HelpDrawer")).toBeUndefined();
  });

  it("存在しない problemId は undefined を返すべき", () => {
    expect(loadPluginSlot("does-not-exist", "StatusPanel")).toBeUndefined();
  });
});
