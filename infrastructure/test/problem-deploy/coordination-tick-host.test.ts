import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationStateExpiresAt } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import type { CoordinationConfig } from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import type { PluginImporter } from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader.js";
import type { CoordinationStoreDeps } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import {
  type CoordinationTickDeps,
  coordinationStateChanged,
  handleCoordinationTickBatch,
  parseCoordinationTickBatch,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-tick.js";
import type { CoordinationTickBatch } from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract.js";
import { evalConditionExpression } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * scoring-driven tick (#2324) の **dispatcher 側 tick host**。 plugin の runTick を最小 IAM の
 * CoordinationDispatcher Lambda 内 (= op 経路と同じ場所) で走らせる。 参照 Battle の capture-window
 * クローズ (= 時間経過で state 遷移) が実発火し、 no-op tick では書き込みが出ないこと (= WCU 予算) を観測する。
 */

const CAPTURE_MS = 15 * 60 * 1000;
interface WindowState {
  readonly phase: "open" | "locked";
}
const windowPlugin: CoordinationPlugin<WindowState, unknown, WindowState> = {
  initialState: () => ({ phase: "open" }),
  validateOp: () => ({ ok: true }),
  applyOp: (s) => s,
  tick: (s, eventNowMs) =>
    s.phase === "open" && eventNowMs >= CAPTURE_MS ? { phase: "locked" } : s,
  projectForTeam: (s) => s,
};
const noTickPlugin: CoordinationPlugin<WindowState, unknown, WindowState> = {
  initialState: () => ({ phase: "open" }),
  validateOp: () => ({ ok: true }),
  applyOp: (s) => s,
  projectForTeam: (s) => s,
};

const CONFIG: CoordinationConfig = { cap: { plugin: "coordination/cap.ts" } };
const importerOf =
  (mod: unknown): PluginImporter =>
  async () =>
    mod;
const nullImporter: PluginImporter = async () => {
  throw new Error("no module");
};

interface FakePut {
  readonly PK: string;
  /** [Issue #3150] Unwrapped -- the plugin's own state, envelope stripped. */
  readonly state: unknown;
  readonly version: number;
}
/** [Issue #3150] The envelope actually written to the `state` attribute. */
interface FakeEnvelopePut {
  readonly PK: string;
  readonly stateSchemaVersion: number | undefined;
  readonly state: unknown;
}
interface FakeDdb {
  readonly store: CoordinationStoreDeps;
  readonly puts: FakePut[];
  /** [Issue #3150] Same writes as `puts`, but envelope-shaped and un-stripped. */
  readonly envelopePuts: FakeEnvelopePut[];
  readonly secretPuts: PutCommand[];
  readonly updates: UpdateCommand[];
  /** [Issue #3187] The roster reads (a GSI1 Query) the tick issues before it initialises. */
  readonly queries: QueryCommand[];
  readonly send: ReturnType<typeof vi.fn>;
}
function fakeDdb(opts: {
  getItem?: Record<string, unknown>;
  conflict?: boolean;
  getThrows?: boolean;
  updateThrows?: unknown;
  matchSecret?: string;
  /** [Issue #3153] The run pointer row, when the problem has been reset. */
  runPointer?: Record<string, unknown>;
  /**
   * [Issue #3187] The tenant's deployment rows, as the roster query (GSI1,
   * `TENANT#<tenantId>`, filtered to the event) returns them. Raw items: the
   * real `itemToRecord` runs on them, the same way the op path's fake does.
   */
  rosterItems?: Record<string, unknown>[];
  /** [Issue #3187] Fail the roster query only; the state and secret reads still answer. */
  rosterThrows?: boolean;
  /**
   * [Issue #3151] Overrides the state size budget only.
   *
   * Not done through the runtime's environment: `CONTROL_DATA_BACKEND` picks
   * the budget AND the repository, so setting it to `turso` here would send the
   * store looking for a libSQL client that unit tests deliberately do not have.
   * The budget's own derivation is pinned in `coordination-state-budget.test.ts`.
   */
  budget?: { backend: "dynamodb" | "pure"; maxBytes: number; warnBytes: number };
}): FakeDdb {
  const puts: FakePut[] = [];
  const envelopePuts: FakeEnvelopePut[] = [];
  const secretPuts: PutCommand[] = [];
  const updates: UpdateCommand[] = [];
  const queries: QueryCommand[] = [];

  // [Issue #3133] The coordination partition now holds two rows — `SK=STATE`
  // and `SK=MATCHSECRET` — so each command handler branches on the sort key
  // first. Split out of `send` so the dispatch stays one flat switch.
  const isSecret = (sk: string | undefined) => sk === "MATCHSECRET";

  const handleGet = (cmd: GetCommand) => {
    if (opts.getThrows) throw new Error("get boom");
    const key = (cmd.input as { Key?: { PK?: string; SK?: string } }).Key;
    if (isSecret(key?.SK)) {
      return { Item: opts.matchSecret ? { matchSecret: opts.matchSecret } : undefined };
    }
    // [Issue #3153] The run pointer lives under its own prefix, one level above
    // the runs it names.
    if (String(key?.PK ?? "").startsWith("COORDRUN#")) return { Item: opts.runPointer };
    return { Item: opts.getItem };
  };

  // [Issue #3150] `writeCoordinationState` wraps the plugin's state in the
  // platform envelope before it ever reaches this fake. Unwrap it here so
  // every pre-#3150 assertion below keeps pinning "the plugin's state",
  // not the wire format -- the envelope itself is pinned separately by the
  // tests in the "coordination-state-schema" describe block.
  const unwrapEnvelope = (
    raw: unknown,
  ): { state: unknown; stateSchemaVersion: number | undefined } => {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).__tenkacloudCoordinationEnvelope === 1
    ) {
      const envelope = raw as { state: unknown; stateSchemaVersion: number };
      return { state: envelope.state, stateSchemaVersion: envelope.stateSchemaVersion };
    }
    return { state: raw, stateSchemaVersion: undefined };
  };

  const handlePut = (cmd: PutCommand) => {
    // A `conflict` fixture models a STATE version race and must not also
    // reject the mint, which is a different row.
    if (isSecret((cmd.input as { Item?: { SK?: string } }).Item?.SK)) {
      secretPuts.push(cmd);
      return {};
    }
    if (opts.conflict) throw new ConditionalCheckFailedException({ $metadata: {}, message: "x" });
    const input = cmd.input as { Item: { PK: string; state: unknown; version: number } };
    const { state, stateSchemaVersion } = unwrapEnvelope(input.Item.state);
    puts.push({ PK: input.Item.PK, state, version: input.Item.version });
    envelopePuts.push({ PK: input.Item.PK, stateSchemaVersion, state });
    return {};
  };

  const handleTransaction = (cmd: TransactWriteCommand) => {
    const entries = cmd.input.TransactItems ?? [];
    const reasons = entries.map((entry) => {
      const operation = entry.ConditionCheck ?? entry.Put;
      if (!operation) throw new Error("unexpected transaction operation");
      const stored = entry.ConditionCheck ? opts.runPointer : opts.getItem;
      const valid =
        !(entry.Put && opts.conflict) &&
        evalConditionExpression(
          operation.ConditionExpression ?? "",
          stored ?? {},
          operation.ExpressionAttributeNames,
          operation.ExpressionAttributeValues,
        );
      return { Code: valid ? "None" : "ConditionalCheckFailed" };
    });
    // Validate every condition before recording any Put, like DynamoDB's
    // all-or-nothing active-run and state-version transaction.
    if (reasons.some((reason) => reason.Code === "ConditionalCheckFailed")) {
      throw Object.assign(new Error("transaction conflict"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    }
    for (const entry of entries) {
      if (entry.Put) handlePut(new PutCommand(entry.Put));
    }
    return {};
  };

  // [Issue #3123] The TTL refresh. Recorded rather than folded into `puts`:
  // the distinction the tests care about is exactly that it is not a write of
  // `state`/`version`.
  const handleUpdate = (cmd: UpdateCommand) => {
    if (opts.updateThrows !== undefined) throw opts.updateThrows;
    updates.push(cmd);
    return {};
  };

  // [Issue #3187] The roster read. The only Query this host issues, and it is
  // a single page: no `LastEvaluatedKey`, or `queryAllPages` would loop.
  const handleQuery = (cmd: QueryCommand) => {
    if (opts.rosterThrows) throw new Error("roster boom");
    queries.push(cmd);
    return { Items: opts.rosterItems ?? [] };
  };

  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return handleGet(cmd);
    if (cmd instanceof PutCommand) return handlePut(cmd);
    if (cmd instanceof TransactWriteCommand) return handleTransaction(cmd);
    if (cmd instanceof UpdateCommand) return handleUpdate(cmd);
    if (cmd instanceof QueryCommand) return handleQuery(cmd);
    throw new Error("unexpected command");
  });
  return {
    store: {
      runtime: opts.budget
        ? { ...makeTestControlDataRuntime(), coordinationStateBudget: () => opts.budget as never }
        : makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "Deployments",
    },
    puts,
    envelopePuts,
    secretPuts,
    updates,
    queries,
    send,
  };
}

const depsWith = (
  importer: PluginImporter,
  store: CoordinationStoreDeps,
): CoordinationTickDeps => ({
  importer,
  store,
  config: CONFIG,
});
const NOW_ISO = "2026-06-01T01:00:00.000Z";
const batch = (
  targets: CoordinationTickBatch["targets"],
  nowIso = NOW_ISO,
): CoordinationTickBatch => ({ action: "coordination-tick", nowIso, targets });
const capTarget = (over: Partial<CoordinationTickBatch["targets"][number]> = {}) => ({
  tenantId: "t1",
  eventId: "e1",
  moduleRef: "cap",
  eventNowMs: CAPTURE_MS,
  teamIds: ["team-a", "team-b"],
  ...over,
});

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warnSpy.mockRestore());

describe("handleCoordinationTickBatch", () => {
  it("should close the capture window and write the advanced state (reference Battle)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 2 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 1 });
    expect(ddb.puts).toEqual([
      { PK: "COORD#t1#e1#cap#default", state: { phase: "locked" }, version: 3 },
    ]);
  });

  it("should NOT write state when the tick is a no-op (before the window)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
  });

  /**
   * [Issue #3123] A no-op tick still refreshes the row's TTL. The tick is the
   * platform's liveness signal -- it runs for every coordination problem in a
   * started event whether or not the plugin implements `tick` -- so anchoring
   * retention to it is what stops a plugin like
   * `microservice-migration-battle`'s `router.ts` (no `tick` hook at all) from
   * ageing out mid-match and silently rebuilding from `initialState`.
   *
   * The refresh must not touch `state` or `version`: bumping the version every
   * minute would invalidate in-flight optimistic locks and manufacture
   * conflicts against a row nothing changed.
   */
  it("should refresh the TTL on a no-op tick without touching state or version", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );

    expect(ddb.updates).toHaveLength(1);
    expect(ddb.updates[0]?.input.Key).toEqual({ PK: "COORD#t1#e1#cap#default", SK: "STATE" });
    expect(ddb.updates[0]?.input.UpdateExpression).toBe("SET expiresAt = :expiresAt");
    // Guards against creating a row for a namespace that does not exist.
    expect(ddb.updates[0]?.input.ConditionExpression).toBe("attribute_exists(version)");
    expect(ddb.updates[0]?.input.ExpressionAttributeValues).toEqual({
      ":expiresAt": coordinationStateExpiresAt(Date.parse(NOW_ISO)),
    });
    expect(ddb.puts).toHaveLength(0);
  });

  /** A row still well inside its window is left alone -- one write per
   *  half-window per namespace, not one per minute. */
  it("should not refresh a TTL that is still fresh", async () => {
    const ddb = fakeDdb({
      getItem: {
        state: { phase: "open" },
        version: 1,
        expiresAt: coordinationStateExpiresAt(Date.parse(NOW_ISO)),
      },
    });
    await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );

    expect(ddb.updates).toHaveLength(0);
  });

  /**
   * There is nothing to keep alive before the first write: the state the tick
   * just built is `plugin.initialState`, and a row holding only a TTL is one no
   * read could interpret.
   */
  it("should not refresh a TTL when the namespace has no row yet", async () => {
    const ddb = fakeDdb({ getItem: undefined });
    await handleCoordinationTickBatch(
      depsWith(importerOf(noTickPlugin), ddb.store),
      batch([capTarget()]),
    );

    expect(ddb.updates).toHaveLength(0);
    expect(ddb.puts).toHaveLength(0);
  });

  /**
   * A missed refresh still leaves half the retention window of margin, so the
   * batch must not lose the other targets over it. Failing the tick here would
   * turn a cosmetic write failure into a scoring outage.
   */
  it.each([
    ["an Error", new Error("update boom"), "update boom"],
    // An SDK or a plugin can reject with something that is not an Error; the
    // warn must still say what happened rather than logging "[object Object]"
    // or dropping the reason.
    ["a non-Error rejection", "update boom", "update boom"],
  ])("should keep ticking when the TTL refresh fails with %s", async (_label, thrown, message) => {
    const ddb = fakeDdb({
      getItem: { state: { phase: "open" }, version: 1 },
      updateThrows: thrown,
    });

    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );

    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ttl refresh failed"),
      expect.objectContaining({ message }),
    );
  });

  it("should NOT write when the plugin has no tick hook", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(noTickPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
  });

  it("should initialize an absent row and write when the tick advances it", async () => {
    const ddb = fakeDdb({ getItem: undefined });
    await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(ddb.puts).toEqual([
      { PK: "COORD#t1#e1#cap#default", state: { phase: "locked" }, version: 1 },
    ]);
  });

  it("should skip a target whose problemId does not declare coordination (config gate, no load/read)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const importer = vi.fn(importerOf(windowPlugin));
    const res = await handleCoordinationTickBatch(
      depsWith(importer, ddb.store),
      batch([capTarget({ moduleRef: "undeclared" })]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(importer).not.toHaveBeenCalled();
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it("should skip and warn when the plugin cannot be loaded (no store read)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const res = await handleCoordinationTickBatch(
      depsWith(nullImporter, ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("plugin unavailable"));
  });

  it("should treat an optimistic-write conflict as no write (warn, not throw)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 }, conflict: true });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick write conflict"));
  });

  it("should isolate a per-target failure and keep ticking the rest", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const key = (cmd.input as { Key: { PK: string } }).Key.PK;
        if (key === "COORD#t1#e1#cap#default") throw new Error("get boom");
      }
      return ddb.send(cmd);
    });
    const store: CoordinationStoreDeps = {
      ...ddb.store,
      ddb: { send } as never,
    };
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), store),
      batch([capTarget(), capTarget({ eventId: "e2" })]),
    );
    expect(res.ticked).toBe(2);
    expect(res.written).toBe(1);
    expect(ddb.puts.map((put) => put.PK)).toEqual(["COORD#t1#e2#cap#default"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("tick failed event=e1"),
      expect.anything(),
    );
  });

  it("should stringify a non-Error per-target rejection in the warn", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) throw "plain get failure";
      return {};
    });
    const store: CoordinationStoreDeps = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "Deployments",
    };
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick failed"), {
      message: "plain get failure",
    });
  });

  it("should return zero over an empty batch (no store access)", async () => {
    const ddb = fakeDdb({ getItem: undefined });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([]),
    );
    expect(res).toEqual({ ticked: 0, written: 0 });
    expect(ddb.send).not.toHaveBeenCalled();
  });
});

describe("parseCoordinationTickBatch", () => {
  it("should parse a valid tick batch and default teamIds", () => {
    const parsed = parseCoordinationTickBatch({
      action: "coordination-tick",
      nowIso: "2026-06-01T01:00:00.000Z",
      targets: [{ tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: 1 }],
    });
    expect(parsed?.targets[0].teamIds).toEqual([]);
  });

  it("should return null for a non-tick payload (HTTP event / wrong action / missing fields)", () => {
    expect(parseCoordinationTickBatch({ requestContext: { http: { method: "GET" } } })).toBeNull();
    expect(parseCoordinationTickBatch({ action: "other", nowIso: "x", targets: [] })).toBeNull();
    expect(
      parseCoordinationTickBatch({
        action: "coordination-tick",
        nowIso: "x",
        targets: [{ eventId: "e1" }],
      }),
    ).toBeNull();
    expect(parseCoordinationTickBatch(null)).toBeNull();
  });
});

describe("coordinationStateChanged", () => {
  it("should be false for the same reference and structurally-equal clones, true when different", () => {
    const s = { phase: "open" };
    expect(coordinationStateChanged(s, s)).toBe(false);
    expect(coordinationStateChanged({ phase: "open" }, { phase: "open" })).toBe(false);
    expect(coordinationStateChanged({ phase: "open" }, { phase: "locked" })).toBe(true);
  });
});

/**
 * [Issue #3133] The hole a read-only tick would have left open.
 *
 * The tick persists whatever `runTick` returns, including state it just built
 * from `initialState`. If the tick initialized without a secret, every later op
 * would find that state already present, skip initialization, and never mint —
 * so the whole match would run on the plugin's fallback seed, which is exactly
 * what this issue exists to prevent. The tick therefore resolves the secret by
 * the same rule the op path uses: only when initializing, and minting if absent.
 */
describe("coordination tick match secret", () => {
  const seedPlugin: CoordinationPlugin<{ seed: string }, unknown, { seed: string }> = {
    initialState: (ctx) => ({ seed: ctx.matchSecret ?? `fallback:${ctx.eventId}` }),
    validateOp: () => ({ ok: true }),
    applyOp: (s) => s,
    // Always advances, so the tick-initialized state is actually written.
    tick: (s) => ({ seed: `${s.seed}!` }),
    projectForTeam: (s) => s,
  };

  it("should mint a secret before persisting state it initialized itself", async () => {
    const ddb = fakeDdb({ getItem: undefined });
    const result = await handleCoordinationTickBatch(
      depsWith(importerOf({ default: seedPlugin }), ddb.store),
      batch([
        { tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: CAPTURE_MS, teamIds: ["a"] },
      ]),
    );

    expect(result.written).toBe(1);
    expect(ddb.secretPuts).toHaveLength(1);
    const persisted = ddb.puts[0]?.state as { seed: string };
    expect(persisted.seed).not.toContain("fallback:");
    expect(persisted.seed).toMatch(/^[0-9a-f]{64}!$/);
  });

  it("should reuse an already issued secret rather than minting a second one", async () => {
    const ddb = fakeDdb({ getItem: undefined, matchSecret: "issued-by-first-op" });
    await handleCoordinationTickBatch(
      depsWith(importerOf({ default: seedPlugin }), ddb.store),
      batch([
        { tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: CAPTURE_MS, teamIds: ["a"] },
      ]),
    );

    expect(ddb.secretPuts).toHaveLength(0);
    expect((ddb.puts[0]?.state as { seed: string } | undefined)?.seed).toBe("issued-by-first-op!");
  });

  it("should not touch the secret when the match already has state", async () => {
    const ddb = fakeDdb({ getItem: { state: { seed: "existing" }, version: 2 } });
    await handleCoordinationTickBatch(
      depsWith(importerOf({ default: seedPlugin }), ddb.store),
      batch([
        { tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: CAPTURE_MS, teamIds: ["a"] },
      ]),
    );

    // `initialState` is the only hook that takes ctx, so an established match
    // needs no secret and must not pay a read or a write for one.
    const secretReads = ddb.send.mock.calls
      .map((c) => c[0] as { input?: { Key?: { SK?: string } } })
      .filter((c) => c.input?.Key?.SK === "MATCHSECRET");
    expect(secretReads).toEqual([]);
    expect(ddb.secretPuts).toEqual([]);
  });
});

/**
 * [Issue #3150] The tick host reconciles a row's `stateSchemaVersion` the
 * same way `dispatchCoordinationOp` does -- same rule, same module
 * (`coordination-state-schema.ts`) -- but a mismatch here must not let a
 * live match's TTL lapse: the tick is the platform's liveness signal, and
 * refusing to advance a stuck row must not also let it silently expire.
 */
describe("tick schema reconciliation (Issue #3150)", () => {
  interface WindowStateV1 {
    readonly phase: "open" | "locked";
  }
  interface WindowStateV2 {
    readonly phase: "open" | "locked";
    readonly bonusRounds: number;
  }

  /** Same window-close behavior as `windowPlugin`, but declares v2 with a migration. */
  const migratableWindowPlugin: CoordinationPlugin<WindowStateV2, unknown, WindowStateV2> = {
    stateSchemaVersion: 2,
    migrateState: (state) => ({ phase: (state as WindowStateV1).phase, bonusRounds: 0 }),
    initialState: () => ({ phase: "open", bonusRounds: 0 }),
    validateOp: () => ({ ok: true }),
    applyOp: (s) => s,
    tick: (s, eventNowMs) =>
      s.phase === "open" && eventNowMs >= CAPTURE_MS ? { ...s, phase: "locked" } : s,
    projectForTeam: (s) => s,
  };

  it("[tick #1] should refuse a schema mismatch (no write) but still refresh the TTL, so the match does not disappear", async () => {
    // `missing_migration` is gated out at load time by `coordinationPluginSchemaDefect`
    // (a real plugin can never reach the tick host without a migration once
    // it declares v2+) -- so the mismatch reachable through the FULL loader
    // path is `newer_row`: a row stamped by a plugin newer than the one
    // currently loaded (a rollback, most often).
    const ddb = fakeDdb({
      getItem: {
        state: {
          __tenkacloudCoordinationEnvelope: 1,
          stateSchemaVersion: 3,
          state: { phase: "open", bonusRounds: 0 },
        },
        version: 1,
      },
    });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(migratableWindowPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick schema mismatch"));
    // The liveness refresh still runs -- a namespace stuck on a mismatch must
    // not also silently age out.
    expect(ddb.updates).toHaveLength(1);
    expect(ddb.updates[0]?.input.UpdateExpression).toBe("SET expiresAt = :expiresAt");
  });

  /**
   * [Issue #3150] Codex review: 版宣言が壊れた plugin を bundle 不在と同じ早期 return にすると、
   * scope も導出されず TTL も延びない。 retention (7 日) を過ぎれば **進行中の行が消え**、
   * 直したあとの plugin は何事も無かったように `initialState` から始まる -- この Issue が
   * 閉じたい「静かに壊れる」そのもの。 state は進めず、 行の生存だけ守る。
   */
  it("[tick #1b] should refuse a plugin whose schema declaration is broken, without a write, but still refresh the TTL", async () => {
    const noMigrate: CoordinationPlugin<WindowStateV2, unknown, WindowStateV2> = {
      ...migratableWindowPlugin,
      migrateState: undefined,
    };
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(noMigrate), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tick invalid plugin schema"));
    expect(ddb.updates).toHaveLength(1);
    expect(ddb.updates[0]?.input.UpdateExpression).toBe("SET expiresAt = :expiresAt");
  });

  it("[tick #2] should migrate a pre-envelope row and persist it under a v2 envelope when the tick actually advances the state", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 2 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(migratableWindowPlugin), ddb.store),
      batch([capTarget()]),
    );
    expect(res).toEqual({ ticked: 1, written: 1 });
    expect(ddb.puts).toEqual([
      { PK: "COORD#t1#e1#cap#default", state: { phase: "locked", bonusRounds: 0 }, version: 3 },
    ]);
    expect(ddb.envelopePuts).toEqual([
      {
        PK: "COORD#t1#e1#cap#default",
        stateSchemaVersion: 2,
        state: { phase: "locked", bonusRounds: 0 },
      },
    ]);
  });

  /**
   * The lazy-upgrade contract: migrating without a state change must not
   * write. The row is left exactly as it was (still pre-envelope) -- only
   * the TTL moves, and the next tick (or op) migrates again, idempotently.
   */
  it("[tick #3] should NOT write when migration is needed but the tick itself is a no-op -- the row stays on its old version, TTL still refreshes", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 2 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(migratableWindowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
    expect(ddb.envelopePuts).toHaveLength(0);
    expect(ddb.updates).toHaveLength(1);
    expect(ddb.updates[0]?.input.UpdateExpression).toBe("SET expiresAt = :expiresAt");
  });
});

describe("the tick and the rest of the platform agree about which match (#3151 / #3153)", () => {
  it("should tick the run the problem was reset onto, not the initial one", async () => {
    const ddb = fakeDdb({
      getItem: { state: { phase: "open" }, version: 2 },
      runPointer: { runId: "rNEW", startedAt: NOW_ISO, history: ["default"] },
    });

    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );

    // A tick left on the constant would advance a retired match while the one
    // participants are playing went unticked — the two halves of the platform
    // operating on different games.
    expect(res).toEqual({ ticked: 1, written: 1 });
    expect(ddb.puts).toEqual([
      { PK: "COORD#t1#e1#cap#rNEW", state: { phase: "locked" }, version: 3 },
    ]);
  });

  it("should report an over-budget tick without taking the batch down", async () => {
    const ddb = fakeDdb({
      getItem: { state: { phase: "open" }, version: 2 },
      // A ceiling small enough that the advanced state cannot fit.
      budget: { backend: "dynamodb", maxBytes: 8, warnBytes: 4 },
    });

    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );

    // Nothing was written, and the pass carried on: taking down the whole
    // scoring batch for one full match would turn one stopped game into an
    // outage for every other event.
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toEqual([]);
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("state over budget");
  });

  it("should keep refreshing the TTL of a match it cannot write", async () => {
    const ddb = fakeDdb({
      // Past the halfway mark, so the tick is due to refresh.
      getItem: { state: { phase: "open" }, version: 2, expiresAt: 1 },
      budget: { backend: "dynamodb", maxBytes: 8, warnBytes: 4 },
    });

    await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget()]),
    );

    // Being unable to write and the match being over are different things.
    // Letting the retention clock run here would delete the row before an
    // operator could act on the warning.
    expect(ddb.updates).toHaveLength(1);
  });
});

/**
 * [Issue #3187] The tick materialises the same roster the op path would.
 *
 * The scoring Lambda ticks every minute from the moment the event starts, so
 * the tick -- not the first participant to open the portal -- is usually the
 * host that materialises a namespace. `initialState` is the only hook that
 * receives ctx, so whatever the tick passes is what the plugin knows about the
 * teams for the whole match. On live it passed the scoring pass's ids alone:
 * COMPLETE rows only, and no names, so every team stayed a ULID even after
 * #3172 had wired display names into the op path.
 */
describe("the tick materialises the roster the op path would (#3187)", () => {
  interface RosterState {
    readonly teams: readonly { readonly id: string; readonly name?: string }[];
    readonly ticks: number;
  }
  const rosterPlugin: CoordinationPlugin<RosterState, unknown, RosterState> = {
    initialState: (ctx) => ({
      teams: ctx.teamIds.map((id) => ({ id, name: ctx.teamNames?.[id] })),
      ticks: 0,
    }),
    validateOp: () => ({ ok: true }),
    applyOp: (s) => s,
    // Always advances, so the tick-initialised state is actually written.
    tick: (s) => ({ ...s, ticks: s.ticks + 1 }),
    projectForTeam: (s) => s,
  };
  const deploymentRow = (over: Record<string, unknown>) => ({
    tenantId: "t1",
    eventId: "e1",
    problemId: "cap",
    ...over,
  });
  const persistedTeams = (ddb: FakeDdb) => (ddb.puts[0]?.state as RosterState | undefined)?.teams;

  it("should hand initialState the full roster with display names, not the scoring pass's ids alone", async () => {
    const ddb = fakeDdb({
      getItem: undefined,
      rosterItems: [
        deploymentRow({
          teamId: "team-b",
          status: "COMPLETE",
          displayTeamName: "かけら隊",
          teamName: "team-2",
        }),
        // Mid-deploy, so the scoring pass (COMPLETE rows only) never observed
        // it. Still on the roster and still named: status is not a filter,
        // or the roster would depend on deploy timing (#3053).
        deploymentRow({ teamId: "team-c", status: "PENDING", teamName: "team-3" }),
        // Another problem in the same event is another match.
        deploymentRow({
          teamId: "team-z",
          status: "COMPLETE",
          problemId: "other",
          displayTeamName: "elsewhere",
        }),
      ],
    });

    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(rosterPlugin), ddb.store),
      // Unsorted on purpose: the scoring pass emits ids in scan order.
      batch([capTarget({ teamIds: ["team-b", "team-a"] })]),
    );

    expect(res).toEqual({ ticked: 1, written: 1 });
    // The union of what the scoring pass observed and what the rows say,
    // sorted -- the same input `initialState` gets when a participant's op
    // materialises the match instead, so who wins the race no longer matters.
    expect(persistedTeams(ddb)).toEqual([
      { id: "team-a", name: undefined },
      { id: "team-b", name: "かけら隊" },
      { id: "team-c", name: "team-3" },
    ]);
    // The same rows the op path reads: the tenant's GSI1 partition, filtered to the event.
    expect(ddb.queries).toHaveLength(1);
    expect(ddb.queries[0]?.input.IndexName).toBe("GSI1");
    expect(ddb.queries[0]?.input.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#t1",
      ":ev": "e1",
    });
  });

  it("should defer initialization when the full roster query fails", async () => {
    const ddb = fakeDdb({ getItem: undefined, rosterThrows: true });

    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(rosterPlugin), ddb.store),
      batch([capTarget({ teamIds: ["team-b", "team-a"] })]),
    );

    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
    expect(persistedTeams(ddb)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("tick failed event=e1"),
      expect.objectContaining({ message: "roster boom" }),
    );
  });

  it("should not read the roster when the match already has state", async () => {
    const ddb = fakeDdb({
      getItem: { state: { teams: [], ticks: 0 }, version: 1 },
      rosterItems: [deploymentRow({ teamId: "team-a", displayTeamName: "late" })],
    });

    await handleCoordinationTickBatch(
      depsWith(importerOf(rosterPlugin), ddb.store),
      batch([capTarget()]),
    );

    // `initialState` is the only hook that takes ctx, so an established match
    // must not pay a Query per minute for a roster nothing can consume.
    expect(ddb.queries).toHaveLength(0);
  });
});
