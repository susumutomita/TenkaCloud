import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearSlotComponentCache, _listDiscoveredPluginKeys, loadPluginSlot } from "./loader";

afterEach(() => {
  _clearSlotComponentCache();
});

/**
 * plugin loader が Vite glob で問題 dir 配下の portal tsx を
 * discover できることと、 metadata.dashboard.slots → component の lookup が正しいことを pin。
 */
describe("plugin loader", () => {
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

/**
 * Issue #1251: metadata で slot が宣言されているのに glob で対応 file が見つからない場合は
 * silent fallback (= console.warn) を撤去し、 console.error で operator に降ろした上で
 * Lazy の Promise を reject する。 erroring lazy が ErrorBoundary に catch されることで
 * UI 側でも user-visible Alert を出し、失敗を隠さない。
 */
describe("plugin loader unresolved-slot reporting (Issue #1251)", () => {
  it("should call console.error (not warn) and reject the lazy loader when metadata declares a slot but the glob has no matching file", async () => {
    // 専用に mock し、 metadata は declare しているが glob 上に存在しない file path を返させる
    vi.resetModules();
    vi.doMock("../data/problems", () => ({
      findProblemMetadata: () => ({
        id: "fixture-missing",
        dashboardSlots: { StatusPanel: "portal/DoesNotExist.tsx" },
      }),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { loadPluginSlot: load } = await import("./loader");
      const Comp = load("fixture-missing", "StatusPanel");
      // metadata 宣言があるので erroring lazy が返ること (undefined では絶対にない)
      expect(Comp).toBeDefined();
      // React.lazy は内部 ctor を呼ぶことで lazy の loader を発火させる。 React 18+ の
      // LazyExoticComponent 構造に直接依存せず、 ctor を 1 回呼んで loader を起動する。
      const lazyRecord = Comp as unknown as {
        _init?: (payload: unknown) => unknown;
        _payload?: unknown;
      };
      if (typeof lazyRecord._init === "function" && lazyRecord._payload !== undefined) {
        try {
          lazyRecord._init(lazyRecord._payload);
        } catch {
          // 初回 call は Promise を throw する (= Suspense 用 thenable)。 catch して握り潰す。
        }
      }
      // microtask queue を drain して lazy 内部 Promise の reject handler を流す
      await Promise.resolve();
      await Promise.resolve();
      const errCalls = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errCalls.some(
          (c) =>
            c.includes("[portal-plugin] unresolved slot") &&
            c.includes("problemId=fixture-missing"),
        ),
      ).toBe(true);
      // 旧 silent warn は撤去済 (= unresolved slot path で warn は鳴らない)
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((c) => c.includes("[portal-plugin] unresolved slot"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      vi.doUnmock("../data/problems");
      vi.resetModules();
    }
  });
});
