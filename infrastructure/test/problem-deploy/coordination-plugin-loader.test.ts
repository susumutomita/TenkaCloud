import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
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
const dispatchInput = {
  scope,
  teamId: "t1",
  op: { kind: "inc" } as CounterOp,
  ctx,
  fallbackProjection: { count: -1 },
  nowIso: "2026-06-01T00:00:00Z",
};

/** GetCommand → getItem を返し、 PutCommand → ok。 conflict 経路は dispatcher 側 test で網羅済み。 */
function fakeStore(getItem?: Record<string, unknown>): CoordinationStoreDeps {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: getItem };
    if (cmd instanceof PutCommand) return {};
    throw new Error("unexpected command");
  });
  return {
    runtime: makeTestControlDataRuntime(),
    ddb: { send } as never,
    tableName: "Deployments",
  };
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

  /**
   * [Issue #3150] This gate is "deploy が落ちる": synth/activation never runs a
   * plugin (#3154), so this is the first safe point pack-author code is
   * evaluated. A `stateSchemaVersion >= 2` with no `migrateState` fails HERE,
   * before any row is ever touched.
   */
  it("should accept a plugin that declares no schema version at all", () => {
    expect(isCoordinationPlugin(counter)).toBe(true);
  });

  it("should accept stateSchemaVersion 2 paired with a migrateState function", () => {
    expect(
      isCoordinationPlugin({ ...counter, stateSchemaVersion: 2, migrateState: (s: unknown) => s }),
    ).toBe(true);
  });

  it("should reject stateSchemaVersion 2 with no migrateState", () => {
    expect(isCoordinationPlugin({ ...counter, stateSchemaVersion: 2 })).toBe(false);
  });

  it.each([
    ["zero", 0],
    ["a fraction", 1.5],
    ["a string", "2"],
    ["negative", -1],
  ])("should reject stateSchemaVersion that is %s", (_label, stateSchemaVersion) => {
    expect(isCoordinationPlugin({ ...counter, stateSchemaVersion })).toBe(false);
  });

  it("should reject a migrateState that is not a function, regardless of version", () => {
    expect(isCoordinationPlugin({ ...counter, migrateState: "not-a-function" })).toBe(false);
    expect(
      isCoordinationPlugin({
        ...counter,
        stateSchemaVersion: 1,
        migrateState: "not-a-function",
      }),
    ).toBe(false);
  });
});

describe("loadCoordinationPlugin", () => {
  it("should return the plugin from a default export", async () => {
    expect(await loadCoordinationPlugin(importerOf({ default: counter }), "ref")).toBe(counter);
  });

  it("should return the plugin when the module itself is the plugin", async () => {
    expect(await loadCoordinationPlugin(importerOf(counter), "ref")).toBe(counter);
  });

  it("should return null when the importer throws", async () => {
    expect(await loadCoordinationPlugin(throwingImporter, "ref")).toBeNull();
  });

  it("should return null when the module is null or fails the contract", async () => {
    expect(await loadCoordinationPlugin(importerOf(null), "ref")).toBeNull();
    expect(await loadCoordinationPlugin(importerOf({ default: {} }), "ref")).toBeNull();
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
});
