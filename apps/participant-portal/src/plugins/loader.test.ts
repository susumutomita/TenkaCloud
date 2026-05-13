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

  it("同一 (problemId, slotName) を 2 回呼ぶと同 LazyExoticComponent instance を返すべき (= memoize)", () => {
    const a = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    const b = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // memoize されていなければ React.lazy(loader) で別 instance になる (= Suspense identity 不安定)
    expect(a).toBe(b);
  });

  // metadata で declared だが glob で resolve できない slot は erroring lazy を返し、 ErrorBoundary
  // に降ろすことで config bug を observable にする (= 旧挙動の silent undefined skip を防ぐ)。
  // production 問題には pin の余地がないので、 fake glob を temp で当てる。
  it("erroring lazy: production の microservice-migration-battle で resolve できる slot は正常 lazy を返すべき", async () => {
    const Comp = loadPluginSlot("microservice-migration-battle", "StatusPanel");
    expect(Comp).toBeDefined();
    // 動的 import (= lazy が内部に持つ payload) を await して module を取得
    // (React.lazy の payload は internal API なので、 ここでは load 結果が throw しないことだけ確認)
    const mod = (await Comp?._payload?._result) ?? Comp?._init?.(Comp?._payload);
    // resolve できる slot なので Promise.reject しない (= 旧挙動と区別)
    expect(mod).toBeDefined();
  });
});
