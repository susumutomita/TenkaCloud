import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentItem } from "../../lib/problem-deploy/handlers/deploy-handler/types.js";
import {
  type CoordinationHandlerDeps,
  type CoordinationScope,
  handleCoordinationOp,
  handleCoordinationProjection,
  makeCoordinationScopeResolver,
  parseCoordinationConfig,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import type { PluginImporter } from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader.js";
import type { CoordinationStoreDeps } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import {
  fakeParticipantShared,
  fakeParticipantSharedWithItems,
} from "./coordination.test-helpers.js";

/**
 * Issue #1420: coordination route handler を pin する。
 * scope 解決 → 動的 load → dispatch/project の委譲、 認証不可 / plugin 未配線時の safe 応答を観測する。
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

const scope: CoordinationScope = {
  tenantId: "tn1",
  eventId: "e1",
  teamId: "t1",
  ctx: { eventId: "e1", teamIds: ["t1", "t2"] },
  moduleRef: "coordination/alliance.ts",
  fallbackProjection: { count: -1 },
};

function fakeStore(getItem?: Record<string, unknown>): CoordinationStoreDeps {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: getItem };
    if (cmd instanceof PutCommand) return {};
    throw new Error("unexpected command");
  });
  return fakeParticipantShared(send);
}

const importerOf =
  (mod: unknown): PluginImporter =>
  async () =>
    mod;
const throwingImporter: PluginImporter = async () => {
  throw new Error("not configured");
};

function deps(over: Partial<CoordinationHandlerDeps> = {}): CoordinationHandlerDeps {
  return {
    importer: importerOf(counter),
    store: fakeStore(undefined),
    resolveScope: async () => scope,
    ...over,
  };
}

describe("handleCoordinationOp", () => {
  it("should return not_configured when scope cannot be resolved", async () => {
    const out = await handleCoordinationOp(
      deps({ resolveScope: async () => null }),
      "key",
      { kind: "inc" },
      "2026-06-01T00:00:00Z",
    );
    expect(out).toEqual({ kind: "not_configured" });
  });

  it("should load the plugin and apply a valid op", async () => {
    const out = await handleCoordinationOp(deps(), "key", { kind: "inc" }, "2026-06-01T00:00:00Z");
    expect(out).toEqual({ kind: "ok", projection: { count: 1 } });
  });

  it("should surface the plugin's rejection for an invalid op", async () => {
    const out = await handleCoordinationOp(deps(), "key", { kind: "bad" }, "2026-06-01T00:00:00Z");
    expect(out).toEqual({ kind: "rejected", error: "bad_op" });
  });

  it("should map a load failure to unavailable", async () => {
    const out = await handleCoordinationOp(
      deps({ importer: throwingImporter }),
      "key",
      { kind: "inc" },
      "2026-06-01T00:00:00Z",
    );
    expect(out).toEqual({ kind: "unavailable" });
  });
});

describe("handleCoordinationProjection", () => {
  it("should return not_configured when scope cannot be resolved", async () => {
    const out = await handleCoordinationProjection(deps({ resolveScope: async () => null }), "key");
    expect(out).toEqual({ kind: "not_configured" });
  });

  it("should project the loaded plugin's per-team view", async () => {
    const out = await handleCoordinationProjection(
      deps({ store: fakeStore({ state: { count: 7 }, version: 2 }) }),
      "key",
    );
    expect(out).toEqual({ kind: "ok", projection: { count: 7 } });
  });

  it("should fall back to the safe projection when the plugin is unavailable", async () => {
    const out = await handleCoordinationProjection(deps({ importer: throwingImporter }), "key");
    expect(out).toEqual({ kind: "ok", projection: { count: -1 } });
  });
});

describe("parseCoordinationConfig", () => {
  it("should return an empty config for unset / invalid / non-object input", () => {
    expect(parseCoordinationConfig(undefined)).toEqual({});
    expect(parseCoordinationConfig("not json")).toEqual({});
    expect(parseCoordinationConfig("123")).toEqual({});
  });

  it("should parse a problemId → plugin map", () => {
    expect(parseCoordinationConfig('{"p1":{"plugin":"coordination/alliance.ts"}}')).toEqual({
      p1: { plugin: "coordination/alliance.ts" },
    });
  });
});

describe("makeCoordinationScopeResolver", () => {
  function fakeShared(items: Partial<DeploymentItem>[]): ParticipantSharedResources {
    return fakeParticipantSharedWithItems(items);
  }
  const config = { p1: { plugin: "coordination/alliance.ts" } };

  it("should resolve a scope when the team's problem declares coordination", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }]),
      config,
    );
    expect(await resolve("key")).toEqual({
      tenantId: "tn1",
      eventId: "e1",
      teamId: "t1",
      ctx: { eventId: "e1", teamIds: ["t1"] },
      // moduleRef は problemId (= importer の S3 key `coordination/<id>.mjs`)。
      moduleRef: "p1",
      fallbackProjection: {},
    });
  });

  it("should return null when no owned problem declares coordination", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "other" }]),
      config,
    );
    expect(await resolve("key")).toBeNull();
  });

  it("should return null when the deployment row lacks event/team scope", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", problemId: "p1" }]),
      config,
    );
    expect(await resolve("key")).toBeNull();
  });

  it("should return null when the deployment row has no problemId", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1" }]),
      config,
    );
    expect(await resolve("key")).toBeNull();
  });

  // Issue #3053: requester 1 チームだけの ctx では、 相手チームを対象にする op が
  // 必ず `unknown team` で reject され、 チーム間 interaction する plugin
  // (ac26-crypto-battle の hunt など) が原理的に成立しなかった。
  it("should hand the plugin the full event roster, sorted", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        { tenantId: "tn1", eventId: "e1", teamId: "t2", problemId: "p1" },
        { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" },
        { tenantId: "tn1", eventId: "e1", teamId: "t3", problemId: "p1" },
      ]),
      config,
    );
    const scope = await resolve("key");
    // 昇順であることが競合対策の本体: どのチームの request が先に state を materialize
    // しても initialState(ctx) の入力が同一になる。
    expect(scope?.ctx.teamIds).toEqual(["t1", "t2", "t3"]);
  });

  it("should leave out teams that deployed a different problem", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" },
        { tenantId: "tn1", eventId: "e1", teamId: "t9", problemId: "other" },
      ]),
      config,
    );
    const scope = await resolve("key");
    expect(scope?.ctx.teamIds).toEqual(["t1"]);
  });

  it("should still scope the requester when the roster query fails", async () => {
    let call = 0;
    const send = vi.fn(async () => {
      call += 1;
      if (call === 1)
        return { Items: [{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }] };
      throw new Error("roster query failed");
    });
    const shared = fakeParticipantShared(send);
    const scope = await makeCoordinationScopeResolver(shared, config)("key");
    // route ごと落とすより、 requester だけの ctx で従来どおり動く方が安全。
    expect(scope?.ctx.teamIds).toEqual(["t1"]);
  });
});
