import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  coordinationPluginSchemaDefect,
  isCoordinationPlugin,
  loadAndDispatchCoordinationOp,
  loadAndProjectCoordinationForTeam,
  loadCoordinationPlugin,
  type PluginImporter,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader.js";
import type { CoordinationStoreDeps } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * Issue #1420: 問題同梱 coordination plugin の動的 import loader を pin する。
 * import 失敗 / 契約不一致 → safe fallback、 load 成功 → 既存 dispatcher へ委譲、 を観測する。
 */

interface CounterState {
  readonly count: number;
}
type CounterOp = { kind: "inc" } | { kind: "bad" };

const counter: CoordinationPlugin<CounterState, CounterOp, { count: number }> = {
  initialState: () => ({ count: 0 }),
  validateOp: (_s, _t, op) => (op.kind === "bad" ? { ok: false, error: "bad_op" } : { ok: true }),
  applyOp: (s) => ({ count: s.count + 1 }),
  projectForTeam: (s) => ({ count: s.count }),
};

const ctx = { eventId: "e1", teamIds: ["t1", "t2"] };
/** [Issue #3123] The platform-owned persistence namespace for one dispatch. */
const scope = { tenantId: "tn1", eventId: "e1", problemId: "p1", runId: "default" } as const;
const incOp: CounterOp = { kind: "inc" };
const dispatchInput = {
  scope,
  teamId: "t1",
  op: incOp,
  ctx,
  fallbackProjection: { count: -1 },
  nowIso: "2026-06-01T00:00:00Z",
};

/** GetCommand → getItem を返し、 PutCommand → ok。 conflict 経路は dispatcher 側 test で網羅済み。 */
function fakeStore(getItem?: Record<string, unknown>): CoordinationStoreDeps {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: getItem };
    if (cmd instanceof PutCommand || cmd instanceof TransactWriteCommand) return {};
    throw new Error("unexpected command");
  });
  const ddb: CoordinationStoreDeps["ddb"] = { send };
  return { runtime: makeTestControlDataRuntime(), ddb, tableName: "Deployments" };
}

/**
 * [Issue #3150] 契約に反する版宣言を持つ plugin を作る。 型としては通しつつ値だけ意図的に壊すので、
 * assertion は identifier に対して 1 回だけ行い、 object literal には被せない。
 */
function malformedPlugin(extra: Record<string, unknown>): CoordinationPlugin<unknown, unknown> {
  const plugin: Record<string, unknown> = { ...counter, ...extra };
  return plugin as unknown as CoordinationPlugin<unknown, unknown>;
}

/** moduleRef を無視して固定 module を返す importer。 */
const importerOf =
  (mod: unknown): PluginImporter =>
  async () =>
    mod;
const throwingImporter: PluginImporter = async () => {
  throw new Error("module not found");
};

describe("isCoordinationPlugin", () => {
  it("should accept an object with all required hooks", () => {
    expect(isCoordinationPlugin(counter)).toBe(true);
  });

  it("should reject null and non-objects", () => {
    expect(isCoordinationPlugin(null)).toBe(false);
    expect(isCoordinationPlugin("plugin")).toBe(false);
    expect(isCoordinationPlugin(42)).toBe(false);
  });

  it("should reject an object missing any required hook", () => {
    expect(isCoordinationPlugin({ validateOp() {}, applyOp() {}, projectForTeam() {} })).toBe(
      false,
    );
    expect(isCoordinationPlugin({ initialState() {}, applyOp() {}, projectForTeam() {} })).toBe(
      false,
    );
    expect(isCoordinationPlugin({ initialState() {}, validateOp() {}, projectForTeam() {} })).toBe(
      false,
    );
    expect(isCoordinationPlugin({ initialState() {}, validateOp() {}, applyOp() {} })).toBe(false);
  });

  it("should accept a plugin that declares no schema version at all", () => {
    expect(isCoordinationPlugin(counter)).toBe(true);
  });

  /**
   * [Issue #3150] Codex review: schema 宣言の妥当性はこの述語の担当ではなくなった。
   * 「plugin が無い」と「plugin は在るが版宣言が壊れている」を同じ false に潰すと、 caller が
   * 両者を区別できず、 projection は 200 fallback、 tick は TTL 未延長になる。 版の判定は
   * `coordinationPluginSchemaDefect` / `loadCoordinationPlugin` 側で観測する。
   */
  it("should not judge the schema declaration", () => {
    expect(isCoordinationPlugin({ ...counter, stateSchemaVersion: 2 })).toBe(true);
    expect(isCoordinationPlugin({ ...counter, stateSchemaVersion: -1 })).toBe(true);
  });
});

/**
 * [Issue #3150] This gate is "deploy が落ちる": synth/activation never runs a
 * plugin (#3154), so this is the first safe point pack-author code is
 * evaluated. A `stateSchemaVersion >= 2` with no `migrateState` fails HERE,
 * before any row is ever touched.
 */
describe("coordinationPluginSchemaDefect", () => {
  it("should pass a plugin that declares no schema version at all", () => {
    expect(coordinationPluginSchemaDefect(counter)).toBeNull();
  });

  it("should pass stateSchemaVersion 2 paired with a migrateState function", () => {
    expect(
      coordinationPluginSchemaDefect(
        malformedPlugin({ stateSchemaVersion: 2, migrateState: (s: unknown) => s }),
      ),
    ).toBeNull();
  });

  it("should reject stateSchemaVersion 2 with no migrateState", () => {
    expect(coordinationPluginSchemaDefect(malformedPlugin({ stateSchemaVersion: 2 }))).toBe(
      "stateSchemaVersion 2 requires migrateState",
    );
  });

  it.each([
    ["zero", 0],
    ["a fraction", 1.5],
    ["a string", "2"],
    ["negative", -1],
  ])("should reject stateSchemaVersion that is %s", (_label, stateSchemaVersion) => {
    expect(coordinationPluginSchemaDefect(malformedPlugin({ stateSchemaVersion }))).toBe(
      `stateSchemaVersion must be a positive integer, got ${JSON.stringify(stateSchemaVersion)}`,
    );
  });

  /**
   * [Issue #3150] Codex review 2 巡目: 整形が throw すると `invalid_schema` を返せず 500 になり、
   * tick は外側の catch に飛んで TTL 延長に届かない。 pack-author の任意の値で throw しないこと。
   */
  it("should reject exotic values without throwing while formatting them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostileTag = new Proxy(
      {},
      {
        get: (_t, key) => {
          if (key === Symbol.toStringTag) throw new Error("no tag for you");
          return undefined;
        },
      },
    );
    for (const value of [1n, cyclic, Symbol("v"), () => 2, revoked.proxy, hostileTag]) {
      const defect = coordinationPluginSchemaDefect(malformedPlugin({ stateSchemaVersion: value }));
      expect(defect).toContain("stateSchemaVersion must be a positive integer");
    }
  });

  /**
   * [Issue #3150] Codex review 3 巡目: 判定そのものも throw しうる -- revoked Proxy では
   * property を読むだけで throw する。 load から例外が漏れると op / projection は分類できない
   * 500 になり、 tick は TTL を延ばせないまま進行中の行を失う。
   */
  it("should report unavailable instead of throwing when the module itself is hostile", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(await loadCoordinationPlugin(importerOf(revoked.proxy), "ref")).toEqual({
      kind: "unavailable",
    });
    const throwingGet = new Proxy(
      {},
      {
        get: () => {
          throw new Error("hostile getter");
        },
      },
    );
    expect(await loadCoordinationPlugin(importerOf({ default: throwingGet }), "ref")).toEqual({
      kind: "unavailable",
    });
  });

  /**
   * [Issue #3150] Codex review 4 巡目: 必須 hook は読めるのに版宣言の検査だけが throw する
   * plugin を `unavailable` に倒すと、 tick が TTL を延ばさない側に落ちて行が retention で
   * 消える。 構造の throw と版検査の throw は行き先が違う。
   */
  it("should route a throwing schema accessor to invalid_schema, not unavailable", async () => {
    const throwingVersion = {
      ...counter,
      get stateSchemaVersion(): number {
        throw new Error("version getter exploded");
      },
    };
    const load = await loadCoordinationPlugin(importerOf(throwingVersion), "ref");
    expect(load.kind).toBe("invalid_schema");
    expect(load.kind === "invalid_schema" ? load.detail : "").toContain("version getter exploded");
  });

  /**
   * [Issue #3150] Codex review 5 巡目: accessor は throw しなくてもよい -- 検証を通したあとに
   * 値を変えるだけでいい。 下流は await を挟んで読み直すので、 そこで Symbol が返れば突き合わせや
   * write が throw し、 tick は TTL 延長を飛ばして行を失う。 検証した値を焼き付けて防ぐ。
   */
  it("should pin the validated schema version against an accessor that changes after inspection", async () => {
    let reads = 0;
    const shifting = {
      ...counter,
      get stateSchemaVersion(): number {
        reads += 1;
        return reads === 1 ? 1 : (Symbol("gotcha") as unknown as number);
      },
    };
    const load = await loadCoordinationPlugin(importerOf(shifting), "ref");
    expect(load.kind).toBe("ok");
    // 下流は plugin ではなくこちらを読むので、 何度読んでも検証を通した値のまま。
    expect(load.kind === "ok" && load.schema.stateSchemaVersion).toBe(1);
    expect(load.kind === "ok" && load.schema.stateSchemaVersion).toBe(1);
    // plugin 自身は包まずそのまま返す (下の receiver テストを参照)。
    expect(load.kind === "ok" && load.plugin).toBe(shifting);
  });

  /**
   * [Issue #3150] Codex review 6 巡目: 版宣言を plugin に被せた view で持つと、 inherited hook の
   * `this` が view になり、 `#private` を持つ class instance を export する plugin --
   * ごく普通の書き方 -- が private slot を失って throw する。 包まないことをここで固定する。
   */
  it("should keep the original receiver so a class plugin with private fields still works", async () => {
    class PrivateCounter {
      #step = 7;
      stateSchemaVersion = 2;
      migrateState(state: unknown): { count: number } {
        return { count: (state as { count: number }).count + this.#step };
      }
      initialState(): { count: number } {
        return { count: this.#step };
      }
      validateOp(): { ok: true } {
        return { ok: true };
      }
      applyOp(s: { count: number }): { count: number } {
        return { count: s.count + this.#step };
      }
      projectForTeam(s: { count: number }): { count: number } {
        return s;
      }
    }
    const instance = new PrivateCounter();
    const load = await loadCoordinationPlugin(importerOf(instance), "ref");
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    // hook を呼んでも private slot が生きている。
    expect(load.plugin.initialState(ctx)).toEqual({ count: 7 });
    const seed: unknown = { count: 1 };
    const noOp: unknown = {};
    expect(load.plugin.applyOp(seed, "t1", noOp, ctx)).toEqual({ count: 8 });
    // bind 済みなので migrateState も元の receiver で走る。
    expect(load.schema.stateSchemaVersion).toBe(2);
    expect(load.schema.migrateState?.({ count: 1 }, 1)).toEqual({ count: 8 });
  });

  it("should reject a migrateState that is not a function, regardless of version", () => {
    const expected = "migrateState must be a function when declared";
    expect(coordinationPluginSchemaDefect(malformedPlugin({ migrateState: "nope" }))).toBe(
      expected,
    );
    expect(
      coordinationPluginSchemaDefect(
        malformedPlugin({ stateSchemaVersion: 1, migrateState: "nope" }),
      ),
    ).toBe(expected);
  });
});

describe("loadCoordinationPlugin", () => {
  it("should return the plugin from a default export, with the validated schema alongside", async () => {
    expect(await loadCoordinationPlugin(importerOf({ default: counter }), "ref")).toEqual({
      kind: "ok",
      plugin: counter,
      schema: { stateSchemaVersion: 1, migrateState: undefined },
    });
  });

  it("should return the plugin when the module itself is the plugin", async () => {
    const load = await loadCoordinationPlugin(importerOf(counter), "ref");
    expect(load.kind === "ok" && load.plugin).toBe(counter);
  });

  it("should report unavailable when the importer throws", async () => {
    expect(await loadCoordinationPlugin(throwingImporter, "ref")).toEqual({ kind: "unavailable" });
  });

  it("should report unavailable when the module is null or fails the contract", async () => {
    expect(await loadCoordinationPlugin(importerOf(null), "ref")).toEqual({ kind: "unavailable" });
    expect(await loadCoordinationPlugin(importerOf({ default: {} }), "ref")).toEqual({
      kind: "unavailable",
    });
  });

  /**
   * [Issue #3150] Codex review: これが `unavailable` と別物であることが、 projection の 503 と
   * tick の TTL 延長を成り立たせている。 潰すと壊れた deploy が「空だが正常な板」に化ける。
   */
  it("should separate a broken schema declaration from a missing plugin", async () => {
    expect(
      await loadCoordinationPlugin(
        importerOf({ default: { ...counter, stateSchemaVersion: 2 } }),
        "ref",
      ),
    ).toEqual({ kind: "invalid_schema", detail: "stateSchemaVersion 2 requires migrateState" });
  });
});

describe("loadAndDispatchCoordinationOp", () => {
  it("should load the plugin and dispatch a valid op", async () => {
    const outcome = await loadAndDispatchCoordinationOp(
      importerOf(counter),
      "ref",
      fakeStore(undefined),
      dispatchInput,
    );
    expect(outcome).toEqual({ kind: "ok", projection: { count: 1 } });
  });

  it("should surface the plugin's rejection for an invalid op", async () => {
    const outcome = await loadAndDispatchCoordinationOp(
      importerOf(counter),
      "ref",
      fakeStore(undefined),
      { ...dispatchInput, op: { kind: "bad" } },
    );
    expect(outcome).toEqual({ kind: "rejected", error: "bad_op" });
  });

  it("should return plugin_unavailable when the plugin cannot be loaded", async () => {
    const outcome = await loadAndDispatchCoordinationOp(
      throwingImporter,
      "ref",
      fakeStore(undefined),
      dispatchInput,
    );
    expect(outcome).toEqual({ kind: "plugin_unavailable" });
  });
});

describe("loadAndProjectCoordinationForTeam", () => {
  const projectInput = {
    scope,
    teamId: "t1",
    ctx,
    fallbackProjection: { count: -1 },
  };

  it("should project the loaded plugin's per-team view", async () => {
    const out = await loadAndProjectCoordinationForTeam(
      importerOf(counter),
      "ref",
      fakeStore({ state: { count: 5 }, version: 1 }),
      projectInput,
    );
    expect(out).toEqual({ kind: "ok", projection: { count: 5 } });
  });

  it("should return the fallback projection when the plugin is unavailable", async () => {
    const out = await loadAndProjectCoordinationForTeam(
      throwingImporter,
      "ref",
      fakeStore(undefined),
      projectInput,
    );
    expect(out).toEqual({ kind: "ok", projection: { count: -1 } });
  });

  /**
   * [Issue #3150] This loader is a thin delegation over
   * `projectCoordinationForTeam` -- it must not swallow `schema_mismatch`
   * into the fallback. A newer row than the loaded plugin's declared version
   * is the "rolled back" case: `counter` declares no `stateSchemaVersion`
   * (= 1), the row was stamped 3 by a later plugin.
   */
  it("should pass a schema_mismatch through instead of the fallback projection", async () => {
    const out = await loadAndProjectCoordinationForTeam(
      importerOf(counter),
      "ref",
      fakeStore({
        state: { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion: 3, state: { count: 9 } },
        version: 1,
      }),
      projectInput,
    );
    expect(out).toEqual({ kind: "schema_mismatch", reason: "newer_row" });
  });

  /**
   * [Issue #3150] Codex review: 版宣言が壊れた plugin は `unavailable` の fallback に混ぜない。
   * projection は portal がいちばん頻繁に叩く経路なので、 ここで 200 を返すと壊れた deploy が
   * 「空だが正常な板」として無期限に見え続け、 503 は op を投げた参加者にしか届かない。
   */
  it("should surface a broken schema declaration instead of the fallback projection", async () => {
    const out = await loadAndProjectCoordinationForTeam(
      importerOf(malformedPlugin({ stateSchemaVersion: 2 })),
      "ref",
      fakeStore({ state: { count: 5 }, version: 1 }),
      projectInput,
    );
    expect(out).toEqual({
      kind: "schema_mismatch",
      reason: "invalid_plugin_schema",
      detail: "stateSchemaVersion 2 requires migrateState",
    });
  });
});
