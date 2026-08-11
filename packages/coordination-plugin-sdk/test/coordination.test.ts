import { describe, expect, it } from "vitest";
import {
  type CoordinationPlugin,
  defineCoordinationPlugin,
  dispatchOp,
  runTick,
  safeProjectForTeam,
} from "../src/index";

/**
 * Issue #1420: coordination plugin の純 util を pin する。参照 router の例を
 * 参照 plugin として実装し、 dispatchOp (validate→apply / 拒否時 state 不変) と runTick
 * (tick あり/なし) を検証する。 tick を持つ alliance 風 plugin も用意して optional hook 経路を覆う。
 */

interface RouterState {
  readonly routes: Record<string, string>;
}
type RouterOp = { kind: "register"; serviceUrl: string } | { kind: "unregister" };

const router: CoordinationPlugin<RouterState, RouterOp, { otherRoutes: Record<string, string> }> = {
  initialState: (ctx) => ({ routes: Object.fromEntries(ctx.teamIds.map((t) => [t, ""])) }),
  validateOp: (_state, _teamId, op) =>
    op.kind === "register" && !op.serviceUrl.startsWith("https://")
      ? { ok: false, error: "must_be_https" }
      : { ok: true },
  applyOp: (state, teamId, op) => {
    if (op.kind === "register") {
      return { ...state, routes: { ...state.routes, [teamId]: op.serviceUrl } };
    }
    const { [teamId]: _drop, ...rest } = state.routes;
    return { ...state, routes: rest };
  },
  projectForTeam: (state) => ({ otherRoutes: state.routes }),
};

describe("dispatchOp", () => {
  it("should validate then apply an accepted op", () => {
    const r = dispatchOp(router, { routes: {} }, "t1", {
      kind: "register",
      serviceUrl: "https://t1.example",
    });
    expect(r).toEqual({ ok: true, state: { routes: { t1: "https://t1.example" } } });
  });

  it("should reject an invalid op and leave state unchanged", () => {
    const before = { routes: { t1: "https://t1.example" } };
    const r = dispatchOp(router, before, "t2", { kind: "register", serviceUrl: "http://insecure" });
    expect(r).toEqual({ ok: false, error: "must_be_https" });
  });

  it("should apply an unregister op", () => {
    const r = dispatchOp(router, { routes: { t1: "https://x", t2: "https://y" } }, "t1", {
      kind: "unregister",
    });
    expect(r).toEqual({ ok: true, state: { routes: { t2: "https://y" } } });
  });
});

describe("initialState / projectForTeam", () => {
  it("should seed routes for every team", () => {
    expect(router.initialState({ eventId: "e1", teamIds: ["t1", "t2"] })).toEqual({
      routes: { t1: "", t2: "" },
    });
  });

  it("should project the shared routes to a team", () => {
    expect(router.projectForTeam({ routes: { t1: "https://x" } }, "t2")).toEqual({
      otherRoutes: { t1: "https://x" },
    });
  });
});

describe("runTick", () => {
  it("should return state unchanged for a plugin without a tick hook", () => {
    const state = { routes: { t1: "https://x" } };
    expect(runTick(router, state, 1000)).toBe(state);
  });

  it("should run the tick hook when defined", () => {
    // 経過時間で同盟を解消する alliance 風 plugin (tick あり)。
    interface AllianceState {
      readonly allies: readonly string[];
      readonly expiresAtMs: number;
    }
    const alliance: CoordinationPlugin<AllianceState, { kind: "ally"; with: string }> = {
      initialState: () => ({ allies: [], expiresAtMs: 0 }),
      validateOp: () => ({ ok: true }),
      applyOp: (state, _teamId, op) => ({ ...state, allies: [...state.allies, op.with] }),
      tick: (state, eventNowMs) =>
        eventNowMs >= state.expiresAtMs ? { ...state, allies: [] } : state,
      projectForTeam: (state) => state,
    };
    expect(runTick(alliance, { allies: ["t2"], expiresAtMs: 500 }, 1000)).toEqual({
      allies: [],
      expiresAtMs: 500,
    });
    const live = { allies: ["t2"], expiresAtMs: 5000 };
    expect(runTick(alliance, live, 1000)).toBe(live);
  });
});

describe("defineCoordinationPlugin", () => {
  it("should return the plugin unchanged (identity helper for type inference)", () => {
    const defined = defineCoordinationPlugin(router);
    expect(defined).toBe(router);
    // 推論された plugin は dispatchOp にそのまま渡せる。
    const r = dispatchOp(defined, { routes: {} }, "t1", {
      kind: "register",
      serviceUrl: "https://t1.example",
    });
    expect(r).toEqual({ ok: true, state: { routes: { t1: "https://t1.example" } } });
  });
});

describe("safeProjectForTeam", () => {
  it("should return the plugin projection on the happy path", () => {
    expect(
      safeProjectForTeam(router, { routes: { t1: "https://x" } }, "t2", { otherRoutes: {} }),
    ).toEqual({ otherRoutes: { t1: "https://x" } });
  });

  it("should fall back when the plugin projection throws (fail-safe, no portal crash)", () => {
    const buggy: CoordinationPlugin<
      RouterState,
      RouterOp,
      { otherRoutes: Record<string, string> }
    > = {
      ...router,
      projectForTeam: () => {
        throw new Error("plugin bug");
      },
    };
    expect(
      safeProjectForTeam(buggy, { routes: { t1: "https://x" } }, "t2", { otherRoutes: {} }),
    ).toEqual({ otherRoutes: {} });
  });
});
