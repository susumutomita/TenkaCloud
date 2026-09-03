import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentItem } from "../../lib/problem-deploy/handlers/deploy-handler/types.js";
import { clearTenantFlagCacheForTest } from "../../lib/problem-deploy/handlers/participant-handler/challenge-access.js";
import {
  type CoordinationHandlerDeps,
  type CoordinationScope,
  handleCoordinationArtifactFetch,
  handleCoordinationOp,
  handleCoordinationProjection,
  makeCoordinationScopeResolver,
  makeCoordinationScorePublisher,
  parseCoordinationConfig,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-handler.js";
import type { PluginImporter } from "../../lib/problem-deploy/handlers/participant-handler/coordination-plugin-loader.js";
import type { CoordinationStoreDeps } from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";
import {
  fakeArtifactStore,
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
  // [Issue #3123] The platform-owned persistence namespace, carried as one
  // object so a transposed argument cannot land on a valid-looking wrong
  // partition.
  state: { tenantId: "tn1", eventId: "e1", problemId: "p1", runId: "default" },
  teamId: "t1",
  ctx: { eventId: "e1", teamIds: ["t1", "t2"] },
  moduleRef: "coordination/alliance.ts",
  fallbackProjection: { count: -1 },
  // [Issue #3123] The event window the op path checks. Open here: started an
  // hour before the tests' `nowIso`, with no end.
  window: { eventStartsAt: "2026-05-31T23:00:00Z" },
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
    resolveScope: async () => ({ kind: "scope" as const, scope }),
    // [Issue #3152] Required, not optional: a host without a store still has to
    // answer "where did this proof go", and refusing is the only honest answer.
    artifacts: fakeArtifactStore(),
    ...over,
  };
}

describe("handleCoordinationOp", () => {
  it("should return not_configured when scope cannot be resolved", async () => {
    const out = await handleCoordinationOp(
      deps({ resolveScope: async () => ({ kind: "not_configured" as const }) }),
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

  /**
   * [Issue #3123] A finished event's deployment rows stay `COMPLETE` until
   * teardown, so a status-only guard would let participants keep mutating an
   * ended match -- and every write refreshes `expiresAt`, so retention would
   * never start. The tick stops at the same predicate; the op path has to agree
   * or the two disagree about when a match is over.
   */
  it.each([
    [
      "an explicit eventEndsAt in the past",
      { eventStartsAt: "2026-05-31T23:00:00Z", eventEndsAt: "2026-05-31T23:30:00Z" },
    ],
    // #1421: a round with no end still terminates at start + 30 days.
    ["the liveness cap with no eventEndsAt", { eventStartsAt: "2026-04-01T00:00:00Z" }],
    ["an event that has not started", { eventStartsAt: "2026-06-01T09:00:00Z" }],
  ])("should reject an op for %s", async (_label, window) => {
    const store = fakeStore();
    const out = await handleCoordinationOp(
      {
        importer: importerOf(counter),
        store,
        artifacts: fakeArtifactStore(),
        resolveScope: async () => ({ kind: "scope" as const, scope: { ...scope, window } }),
      },
      "key",
      { kind: "inc" },
      "2026-06-01T00:00:00Z",
    );

    expect(out).toEqual({ kind: "rejected", error: "event_ended" });
    // The op must not reach the store at all: no read, and above all no write
    // that would push the TTL out.
    expect(store.ddb.send).not.toHaveBeenCalled();
  });

  /**
   * Reads stay open after the event ends. A projection moves neither state nor
   * TTL, and refusing it would break the post-event review for no gain.
   */
  it("should still serve a projection after the event has ended", async () => {
    const out = await handleCoordinationProjection(
      {
        importer: importerOf(counter),
        store: fakeStore({ state: { count: 3 }, version: 1 }),
        artifacts: fakeArtifactStore(),
        resolveScope: async () => ({
          kind: "scope" as const,
          scope: {
            ...scope,
            window: { eventStartsAt: "2026-05-31T23:00:00Z", eventEndsAt: "2026-05-31T23:30:00Z" },
          },
        }),
      },
      "key",
    );

    expect(out).toEqual({ kind: "ok", projection: { count: 3 } });
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

  /**
   * [Issue #3150] Full-path wiring check: a plugin that DOES load (unlike
   * `unavailable` above) but whose declared version cannot be reconciled
   * against the persisted row must surface as `schema_mismatch`, not a
   * generic failure and not a silently-applied op.
   */
  it("should map a schema mismatch to schema_mismatch instead of applying the op", async () => {
    const counterV2: CoordinationPlugin<CounterState, CounterOp, { count: number }> = {
      stateSchemaVersion: 2,
      migrateState: (state) => state as CounterState,
      ...counter,
    };
    const out = await handleCoordinationOp(
      deps({
        importer: importerOf(counterV2),
        // A row stamped by a plugin newer (v3) than the one now loaded (v2).
        store: fakeStore({
          state: {
            __tenkacloudCoordinationEnvelope: 1,
            stateSchemaVersion: 3,
            state: { count: 9 },
          },
          version: 1,
        }),
      }),
      "key",
      { kind: "inc" },
      "2026-06-01T00:00:00Z",
    );
    expect(out).toEqual({ kind: "schema_mismatch", reason: "newer_row" });
  });

  /**
   * [Issue #3150] Codex review: 版宣言そのものが壊れた plugin も同じ 503 に写る。 参加者に
   * 見えるのは `unavailable` と同じ「今は使えない」だが、 運営の log には理由が残る --
   * これが「壊れた deploy が空の板として無期限に見え続ける」を塞ぐ最後の 1 段。
   */
  it("should map a broken schema declaration to schema_mismatch with a logged reason", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await handleCoordinationOp(
        deps({
          importer: importerOf({ ...counter, stateSchemaVersion: 2 }),
          store: fakeStore({ state: { count: 5 }, version: 1 }),
        }),
        "key",
        { kind: "inc" },
        "2026-06-01T00:00:00Z",
      );
      expect(out).toEqual({
        kind: "schema_mismatch",
        reason: "invalid_plugin_schema",
        detail: "stateSchemaVersion 2 requires migrateState",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('reason=invalid_plugin_schema detail="stateSchemaVersion 2'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("handleCoordinationProjection", () => {
  it("should return not_configured when scope cannot be resolved", async () => {
    const out = await handleCoordinationProjection(
      deps({ resolveScope: async () => ({ kind: "not_configured" as const }) }),
      "key",
    );
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

  /**
   * [Issue #3150] Full-path wiring check for the read side: a mismatch must
   * surface as `schema_mismatch`, never as a 200-shaped `ok` outcome carrying
   * the fallback -- that would be the polled-most route lying about the
   * match's state.
   */
  it("should map a schema mismatch to schema_mismatch instead of the fallback projection", async () => {
    const counterV2: CoordinationPlugin<CounterState, CounterOp, { count: number }> = {
      stateSchemaVersion: 2,
      migrateState: (state) => state as CounterState,
      ...counter,
    };
    const out = await handleCoordinationProjection(
      deps({
        importer: importerOf(counterV2),
        store: fakeStore({
          state: {
            __tenkacloudCoordinationEnvelope: 1,
            stateSchemaVersion: 3,
            state: { count: 9 },
          },
          version: 1,
        }),
      }),
      "key",
    );
    expect(out).toEqual({ kind: "schema_mismatch", reason: "newer_row" });
  });
  /**
   * [Issue #3150] Codex review: 版宣言そのものが壊れた plugin も同じ 503 に写る。 参加者に
   * 見えるのは `unavailable` と同じ「今は使えない」だが、 運営の log には理由が残る --
   * これが「壊れた deploy が空の板として無期限に見え続ける」を塞ぐ最後の 1 段。
   */
  it("should map a broken schema declaration to schema_mismatch with a logged reason", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await handleCoordinationProjection(
        deps({
          importer: importerOf({ ...counter, stateSchemaVersion: 2 }),
          store: fakeStore({ state: { count: 5 }, version: 1 }),
        }),
        "key",
      );
      expect(out).toEqual({
        kind: "schema_mismatch",
        reason: "invalid_plugin_schema",
        detail: "stateSchemaVersion 2 requires migrateState",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('reason=invalid_plugin_schema detail="stateSchemaVersion 2'),
      );
    } finally {
      warnSpy.mockRestore();
    }
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

  /** Unwrap a successful resolution; `undefined` for anything else. */
  const scopeOf = (r: Awaited<ReturnType<ReturnType<typeof makeCoordinationScopeResolver>>>) =>
    r.kind === "scope" ? r.scope : undefined;

  /**
   * [Issue #3170] The Gate has to reach this route.
   *
   * Live evidence: a team with the Gate challenge untouched started the match,
   * leaked three shares and landed a HUNT for +25, while the page above the
   * board told them the problem was locked. Coordination moved to its own
   * Lambda in #1420 and the guard did not move with it.
   */
  describe("progression gate", () => {
    // The tenant flag cache is module-level with a 30s TTL, so one test's
    // answer would otherwise decide the next one's.
    beforeEach(() => clearTenantFlagCacheForTest());
    const GATED_EVENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    /**
     * Answers the two reads the gate needs: the tenant feature flag row and the
     * event META row that carries the gate config. Everything else falls
     * through to the team's deployment rows.
     */
    function gatedShared(
      items: Partial<DeploymentItem>[],
      opts: { flagOn?: boolean; teamOverrides?: Record<string, unknown> } = {},
    ): ParticipantSharedResources {
      const send = vi.fn(async (cmd: unknown) => {
        const key = (cmd as { input?: { Key?: Record<string, unknown> } }).input?.Key;
        if (cmd instanceof GetCommand && key?.SK === "FLAGS") {
          return { Item: { flags: { challengePrerequisiteGate: opts.flagOn !== false } } };
        }
        if (cmd instanceof GetCommand && key?.SK === "META") {
          return {
            Item: {
              tenantId: "tn1",
              status: "READY",
              startsAt: "2026-01-01T00:00:00.000Z",
              progressionGate: {
                gateProblemId: "hello-world",
                unlockTargetIds: ["p1"],
                defaultPolicy: "required",
                ...(opts.teamOverrides ? { teamOverrides: opts.teamOverrides } : {}),
              },
            },
          };
        }
        return { Items: items };
      });
      // Bound before the assertion: `consistent-type-assertions` wants a
      // declaration it can annotate, and the DocumentClient surface is far
      // wider than the one method this double answers.
      const partial = {
        runtime: makeTestControlDataRuntime(),
        ddb: { send },
        tableName: "Deployments",
        eventsTableName: "Events",
      };
      return partial as unknown as ParticipantSharedResources;
    }

    /** The team's rows: the Gate challenge (unsolved unless scored) and the target. */
    const rows = (gateScore: number): Partial<DeploymentItem>[] => [
      {
        problemId: "hello-world",
        tenantId: "tn1",
        eventId: GATED_EVENT,
        teamId: "t1",
        status: "COMPLETE",
        score: gateScore,
      },
      {
        problemId: "p1",
        tenantId: "tn1",
        eventId: GATED_EVENT,
        teamId: "t1",
        status: "COMPLETE",
        score: 0,
      },
    ];

    it("should refuse the scope while the Gate challenge is unsolved", async () => {
      const resolve = makeCoordinationScopeResolver(gatedShared(rows(0)), config);
      expect(await resolve("key")).toEqual({ kind: "locked", gateProblemId: "hello-world" });
    });

    it("should resolve once the Gate challenge has scored", async () => {
      const resolve = makeCoordinationScopeResolver(gatedShared(rows(10)), config);
      expect(scopeOf(await resolve("key"))?.state.problemId).toBe("p1");
    });

    it("should let a team whose policy is off straight through", async () => {
      const resolve = makeCoordinationScopeResolver(
        gatedShared(rows(0), { teamOverrides: { t1: { policy: "off" } } }),
        config,
      );
      expect(scopeOf(await resolve("key"))?.state.problemId).toBe("p1");
    });

    it("should not lock anything while the tenant flag is off", async () => {
      // The flag is the tenant's opt-in; enforcing without it would lock
      // problems for tenants that never turned the feature on.
      const resolve = makeCoordinationScopeResolver(
        gatedShared(rows(0), { flagOn: false }),
        config,
      );
      expect(scopeOf(await resolve("key"))?.state.problemId).toBe("p1");
    });
  });

  it("should resolve a scope when the team's problem declares coordination", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        {
          tenantId: "tn1",
          eventId: "e1",
          teamId: "t1",
          problemId: "p1",
          eventStartsAt: "2026-05-31T23:00:00Z",
          eventEndsAt: "2026-06-01T09:00:00Z",
        },
      ]),
      config,
    );
    expect(await resolve("key")).toEqual({
      kind: "scope",
      scope: {
        // [Issue #3123] `runId` is NOT an alias of `problemId`: aliasing them
        // would make the two key dimensions indistinguishable, and would collide
        // the moment a real run id ever equalled a problem id. The platform
        // issues one run per (event, problem) today, so the resolver emits the
        // documented default and resetting a run is expressed as deleting the
        // namespace.
        state: { tenantId: "tn1", eventId: "e1", problemId: "p1", runId: "default" },
        teamId: "t1",
        ctx: { eventId: "e1", teamIds: ["t1"] },
        // moduleRef は problemId (= importer の S3 key `coordination/<id>.mjs`)。
        moduleRef: "p1",
        fallbackProjection: {},
        // [Issue #3123] The denormalized event window travels with the scope so
        // the op path can refuse a finished match without a second read.
        window: { eventStartsAt: "2026-05-31T23:00:00Z", eventEndsAt: "2026-06-01T09:00:00Z" },
      },
    });
  });

  /**
   * [Issue #3123] Two teams on DIFFERENT coordination problems in the same
   * event must resolve to different persistence namespaces. Before the key
   * carried `problemId` they shared one row, so whichever problem wrote last
   * overwrote the other's match.
   */
  it("should resolve a distinct namespace per problem in one event", async () => {
    const resolveP1 = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }]),
      { p1: { plugin: "coordination/p1.ts" }, p2: { plugin: "coordination/p2.ts" } },
    );
    const resolveP2 = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t9", problemId: "p2" }]),
      { p1: { plugin: "coordination/p1.ts" }, p2: { plugin: "coordination/p2.ts" } },
    );

    expect(scopeOf(await resolveP1("key"))?.state).toEqual({
      tenantId: "tn1",
      eventId: "e1",
      problemId: "p1",
      runId: "default",
    });
    expect(scopeOf(await resolveP2("key"))?.state).toEqual({
      tenantId: "tn1",
      eventId: "e1",
      problemId: "p2",
      runId: "default",
    });
  });

  /**
   * [Issue #3123] A torn-down deployment stays queryable through the
   * participant login index while it is DELETING and for the seven days its
   * terminal row is retained. Since event cleanup now DELETES the coordination
   * namespace, letting such a row resolve a scope would let the next op
   * re-materialize from `plugin.initialState` -- recreating exactly the row
   * teardown had just removed. Every sibling participant write path already
   * applies this filter.
   */
  it.each([
    "DELETING",
    "DELETED",
    "EXPIRED",
    "AUTO_DELETED",
  ])("should refuse a scope for a %s deployment", async (status) => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1", status }]),
      config,
    );
    expect(await resolve("key")).toEqual({ kind: "not_configured" });
  });

  /**
   * A Deployments row is written in stages, so a row can match the login index
   * before it carries everything a scope needs. Resolving one anyway would name
   * a persistence namespace with an empty segment in it.
   */
  it.each([
    "tenantId",
    "eventId",
    "problemId",
    "teamId",
  ])("should refuse a scope for a row still missing %s", async (missing) => {
    const row = Object.fromEntries(
      Object.entries({ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }).filter(
        ([field]) => field !== missing,
      ),
    );
    expect(await makeCoordinationScopeResolver(fakeShared([row]), config)("key")).toEqual({
      kind: "not_configured",
    });
  });

  it.each([
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "FAILED",
  ])("should still resolve a scope for a %s deployment", async (status) => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1", status }]),
      config,
    );
    expect((await resolve("key")).kind).toBe("scope");
  });

  /**
   * [Issue #3128] The gap status alone could not close.
   *
   * Event teardown moves rows to DELETING and deletes the coordination
   * namespace; the delete state machine then observes DELETE_FAILED and
   * `markFailed` moves the row to FAILED. FAILED is not deleted-like (it is
   * indistinguishable from a failed deploy), so before the marker the row
   * passed this guard, the event window was still open, and the next op rebuilt
   * the match the operator had just ended.
   */
  it.each([
    "FAILED",
    "COMPLETE",
    "PENDING",
    "IN_PROGRESS",
  ])("should refuse a scope for a torn-down deployment that landed on %s", async (status) => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        {
          tenantId: "tn1",
          eventId: "e1",
          teamId: "t1",
          problemId: "p1",
          status,
          teardownRequestedAt: "2026-08-30T09:00:00.000Z",
        },
      ]),
      config,
    );
    expect(await resolve("key")).toEqual({ kind: "not_configured" });
  });

  it("should keep resolving a row written before the teardown marker existed", async () => {
    // Absence means "unknown", not "not torn down" — pre-marker rows keep the
    // previous status-only behaviour rather than being locked out wholesale.
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1", status: "COMPLETE" },
      ]),
      config,
    );
    expect((await resolve("key")).kind).toBe("scope");
  });

  it("should return null when no owned problem declares coordination", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "other" }]),
      config,
    );
    expect(await resolve("key")).toEqual({ kind: "not_configured" });
  });

  it("should return null when the deployment row lacks event/team scope", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", problemId: "p1" }]),
      config,
    );
    expect(await resolve("key")).toEqual({ kind: "not_configured" });
  });

  it("should return null when the deployment row has no problemId", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1" }]),
      config,
    );
    expect(await resolve("key")).toEqual({ kind: "not_configured" });
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
    const scope = scopeOf(await resolve("key"));
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
    const scope = scopeOf(await resolve("key"));
    expect(scope?.ctx.teamIds).toEqual(["t1"]);
  });

  it("should still scope the requester when the roster query fails", async () => {
    // Only the ROSTER query fails. [Issue #3153] added a run-pointer read to
    // this path, and failing that one too would be testing a different claim:
    // a pointer this resolver cannot read means it does not know which match
    // the operation belongs to, and that is deliberately fatal.
    let queries = 0;
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: undefined };
      queries += 1;
      if (queries === 1)
        return { Items: [{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }] };
      throw new Error("roster query failed");
    });
    const shared = fakeParticipantShared(send);
    const scope = scopeOf(await makeCoordinationScopeResolver(shared, config)("key"));
    // route ごと落とすより、 requester だけの ctx で従来どおり動く方が安全。
    expect(scope?.ctx.teamIds).toEqual(["t1"]);
  });

  /**
   * [Issue #3125] Two coordination problems deployed to the SAME team.
   *
   * The resolver used to loop over the team's deployments and return the first
   * one that qualified, so the second problem was unreachable through the
   * participant API — and it did not surface as a failure: the first problem's
   * projection came back fine, so nothing distinguished "the second problem is
   * not there" from "the second problem does not exist".
   */
  describe("when one team has two coordination problems", () => {
    const twoProblems = {
      p1: { plugin: "coordination/p1.ts" },
      p2: { plugin: "coordination/p2.ts" },
    };
    const bothDeployed = () =>
      makeCoordinationScopeResolver(
        fakeShared([
          { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" },
          { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p2" },
        ]),
        twoProblems,
      );

    it("should refuse to guess when no problemId is given", async () => {
      // Picking either one silently is what made the other unreachable.
      expect(await bothDeployed()("key")).toEqual({
        kind: "ambiguous",
        problemIds: ["p1", "p2"],
      });
    });

    it("should reach EITHER problem when the caller names one", async () => {
      expect(scopeOf(await bothDeployed()("key", "p1"))?.state.problemId).toBe("p1");
      // The one that used to be unreachable.
      expect(scopeOf(await bothDeployed()("key", "p2"))?.state.problemId).toBe("p2");
    });

    it("should give each problem its own namespace", async () => {
      const p1 = scopeOf(await bothDeployed()("key", "p1"))?.state;
      const p2 = scopeOf(await bothDeployed()("key", "p2"))?.state;
      expect(p1).not.toEqual(p2);
      expect(p1?.runId).toBe(p2?.runId);
      expect(p1?.eventId).toBe(p2?.eventId);
    });

    it("should not fall back to another problem when the named one is absent", async () => {
      // Resolving a DIFFERENT problem than the one asked for would let a
      // participant operate a match they did not name.
      expect(await bothDeployed()("key", "p3")).toEqual({ kind: "not_configured" });
    });
  });

  /**
   * The common case must not change: one coordination problem, no `problemId`
   * given, resolves exactly as before. Every existing caller relies on this.
   */
  it("should still resolve without a problemId when the team has only one", async () => {
    const resolve = makeCoordinationScopeResolver(
      fakeShared([{ tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" }]),
      config,
    );
    expect(scopeOf(await resolve("key"))?.state.problemId).toBe("p1");
    // And naming it explicitly resolves the same scope.
    expect(scopeOf(await resolve("key", "p1"))?.state).toEqual(
      scopeOf(await resolve("key"))?.state,
    );
  });

  it("should not call a same-problem duplicate deployment ambiguous", async () => {
    // Two rows for ONE problem (e.g. a retried deploy) is not a choice to make.
    const resolve = makeCoordinationScopeResolver(
      fakeShared([
        { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" },
        { tenantId: "tn1", eventId: "e1", teamId: "t1", problemId: "p1" },
      ]),
      config,
    );
    expect(scopeOf(await resolve("key"))?.state.problemId).toBe("p1");
  });
});

/**
 * [Issue #659] A coordination Battle's own scoring reaching the scoreboard.
 *
 * Before this the two were structurally disconnected: such a problem declares
 * no `scoring` (no builtin kind can serve it), and the scoring Lambda does not
 * run plugins, so the portal showed 0 for a team an hour into a match while the
 * plugin's own state held the real figure.
 */
describe("handleCoordinationOp publishing the plugin's scores", () => {
  const scopeFor = () => ({
    kind: "scope" as const,
    scope: {
      state: { tenantId: "tn1", eventId: "e1", problemId: "p1", runId: "default" },
      teamId: "t1",
      ctx: { eventId: "e1", teamIds: ["t1", "t2"] },
      window: { eventStartsAt: "2026-05-31T23:00:00Z", eventEndsAt: "2026-06-01T09:00:00Z" },
      moduleRef: "p1",
      fallbackProjection: {},
    },
  });

  /** A plugin whose score for the acting team moves 0 -> 30 on any op. */
  const scoringPlugin: CoordinationPlugin<{ n: number }, unknown, unknown> = {
    initialState: () => ({ n: 0 }),
    validateOp: () => ({ ok: true }),
    applyOp: (state) => ({ n: state.n + 30 }),
    projectForTeam: (state) => state,
    teamScores: (state) => ({ t1: state.n, t2: 0 }),
  };

  it("publishes only the teams whose score actually moved", async () => {
    const publishScores = vi.fn(async () => undefined);
    await handleCoordinationOp(
      {
        importer: async () => ({ default: scoringPlugin }),
        store: fakeStore({ state: { n: 0 }, version: 1 }),
        resolveScope: async () => scopeFor(),
        publishScores,
      },
      "key",
      { kind: "go" },
      "2026-06-01T00:00:00Z",
    );

    expect(publishScores).toHaveBeenCalledTimes(1);
    const [scope, scores] = publishScores.mock.calls[0] ?? [];
    expect(scope).toEqual({ tenantId: "tn1", eventId: "e1", problemId: "p1", runId: "default" });
    // t2 did not move, so it is not written — an op normally touches one team.
    expect(scores).toEqual({ t1: 30 });
  });

  it("does not publish when a plugin declares no scores", async () => {
    // Every existing plugin is in this position; they must keep behaving as
    // they did, which means writing nothing to the scoreboard.
    const publishScores = vi.fn(async () => undefined);
    const silent: CoordinationPlugin<{ n: number }, unknown, unknown> = {
      initialState: scoringPlugin.initialState,
      validateOp: scoringPlugin.validateOp,
      applyOp: scoringPlugin.applyOp,
      projectForTeam: scoringPlugin.projectForTeam,
    };
    await handleCoordinationOp(
      {
        importer: async () => ({ default: silent }),
        store: fakeStore({ state: { n: 0 }, version: 1 }),
        resolveScope: async () => scopeFor(),
        publishScores,
      },
      "key",
      { kind: "go" },
      "2026-06-01T00:00:00Z",
    );
    expect(publishScores).not.toHaveBeenCalled();
  });

  it("does not publish when the op was rejected", async () => {
    const publishScores = vi.fn(async () => undefined);
    await handleCoordinationOp(
      {
        importer: async () => ({
          default: { ...scoringPlugin, validateOp: () => ({ ok: false, error: "no" }) },
        }),
        store: fakeStore({ state: { n: 0 }, version: 1 }),
        resolveScope: async () => scopeFor(),
        publishScores,
      },
      "key",
      { kind: "go" },
      "2026-06-01T00:00:00Z",
    );
    expect(publishScores).not.toHaveBeenCalled();
  });

  it.each([
    ["an Error", new Error("dynamodb unavailable")],
    ["a bare string", "dynamodb unavailable"],
  ])("still reports the op as accepted when publishing throws %s", async (_label, thrown) => {
    // The state is already committed by this point. Turning a scoreboard write
    // into a rejection would tell the participant their move failed when it did
    // not, and the next op repairs the figure anyway.
    const out = await handleCoordinationOp(
      {
        importer: async () => ({ default: scoringPlugin }),
        store: fakeStore({ state: { n: 0 }, version: 1 }),
        resolveScope: async () => scopeFor(),
        publishScores: async () => {
          throw thrown;
        },
      },
      "key",
      { kind: "go" },
      "2026-06-01T00:00:00Z",
    ).catch((err: unknown) => ({ kind: "threw", err }) as const);
    expect(out.kind).toBe("ok");
  });
});

/**
 * [Issue #659] The default publisher: the only place a Battle's own scoring
 * actually reaches a Deployments row.
 *
 * The repository is faked at the runtime seam rather than at the DynamoDB item
 * level, because what is worth pinning here is the publisher's own arithmetic
 * and filtering — which row it picks, what delta it computes, what it declines
 * to write — not the physical shape of a Query response that
 * `dynamodb-deployments-query` already owns tests for.
 */
describe("makeCoordinationScorePublisher", () => {
  const target = { tenantId: "t1", eventId: "e1", problemId: "p1" } as const;

  function sharedWithRows(
    rows: readonly Record<string, unknown>[],
    applied: { jobId: string; delta: number | undefined }[],
    failWith?: unknown,
  ): ParticipantSharedResources {
    const repository = {
      listByTenantAndEvent: async () => {
        if (failWith) throw failWith;
        return rows;
      },
      applyKindScoringResult: async (jobId: string, result: { scoreDelta?: number }) => {
        applied.push({ jobId, delta: result.scoreDelta });
      },
    };
    const base = fakeParticipantShared(async () => ({}));
    return {
      ...base,
      runtime: {
        ...base.runtime,
        resolveDeploymentsRepository: async () => repository,
      },
    } as unknown as ParticipantSharedResources;
  }

  function publish(
    shared: ParticipantSharedResources,
    scores: Record<string, number>,
  ): Promise<void> {
    return makeCoordinationScorePublisher(shared)(
      { ...target, state: {} } as unknown as Parameters<
        NonNullable<CoordinationHandlerDeps["publishScores"]>
      >[0],
      scores,
      "2026-06-01T00:00:00Z",
    );
  }

  it("writes the difference between the plugin's figure and the row's", async () => {
    // Absolute in, delta out: the plugin says 145, the row holds 100, so 45 is
    // what `ADD score :pts` needs to make the row agree with the match.
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(
      sharedWithRows([{ teamId: "teamA", jobId: "jobA", problemId: "p1", score: 100 }], applied),
      { teamA: 145 },
    );
    expect(applied).toEqual([{ jobId: "jobA", delta: 45 }]);
  });

  it("treats a row that has never scored as zero", async () => {
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(sharedWithRows([{ teamId: "teamA", jobId: "jobA", problemId: "p1" }], applied), {
      teamA: 30,
    });
    expect(applied).toEqual([{ jobId: "jobA", delta: 30 }]);
  });

  it("writes nothing when the row already agrees with the plugin", async () => {
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(
      sharedWithRows([{ teamId: "teamA", jobId: "jobA", problemId: "p1", score: 30 }], applied),
      { teamA: 30 },
    );
    expect(applied).toEqual([]);
  });

  it("leaves another problem's row for that problem to score", async () => {
    // One event runs several problems and a team has a row in each. Scoring the
    // wrong row would move a score the plugin has no authority over.
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(
      sharedWithRows(
        [
          { teamId: "teamA", jobId: "other", problemId: "p2", score: 0 },
          { teamId: "teamA", jobId: "jobA", problemId: "p1", score: 0 },
        ],
        applied,
      ),
      { teamA: 30 },
    );
    expect(applied).toEqual([{ jobId: "jobA", delta: 30 }]);
  });

  it("skips a row with no teamId or no jobId", async () => {
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(
      sharedWithRows(
        [
          { jobId: "noTeam", problemId: "p1", score: 0 },
          { teamId: "teamA", problemId: "p1", score: 0 },
        ],
        applied,
      ),
      { teamA: 30 },
    );
    expect(applied).toEqual([]);
  });

  it("ignores a team the plugin did not report", async () => {
    const applied: { jobId: string; delta: number | undefined }[] = [];
    await publish(
      sharedWithRows([{ teamId: "teamB", jobId: "jobB", problemId: "p1", score: 0 }], applied),
      { teamA: 30 },
    );
    expect(applied).toEqual([]);
  });

  // The repository is reached over the network, and a plugin's own code is not
  // the only thing that can throw a non-Error here.
  it.each([
    ["an Error", new Error("dynamodb unavailable")],
    ["a bare string", "dynamodb unavailable"],
  ])("swallows a repository failure (%s) so the accepted op still stands", async (_l, thrown) => {
    const applied: { jobId: string; delta: number | undefined }[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      publish(sharedWithRows([], applied, thrown), { teamA: 30 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "dynamodb unavailable" }),
    );
    warn.mockRestore();
  });
});

/**
 * [Issue #3152] The artifact half of the op path and the fetch that reads it
 * back.
 *
 * The store itself is pinned in `coordination-artifacts.test.ts`; what is
 * asserted here is the handler's part of the contract — bodies are stored
 * before dispatch, references reach the plugin, and nothing survives an
 * operation that did not commit.
 */
describe("coordination artifacts through the handler (#3152)", () => {
  const artifactOf = (text: string) => ({
    contentType: "application/octet-stream",
    contentBase64: Buffer.from(text).toString("base64"),
  });

  /** A plugin that keeps whatever references the platform handed it. */
  const recorder: CoordinationPlugin<
    { readonly refs: unknown },
    { readonly kind: string; readonly artifacts?: unknown },
    { readonly refs: unknown }
  > = {
    initialState: () => ({ refs: null }),
    validateOp: (_s, _t, op) => (op.kind === "bad" ? { ok: false, error: "bad_op" } : { ok: true }),
    applyOp: (_s, _t, op) => ({ refs: op.artifacts ?? null }),
    projectForTeam: (s) => ({ refs: s.refs }),
  };

  it("should store a body and hand the plugin a reference to it", async () => {
    const artifacts = fakeArtifactStore();
    const out = await handleCoordinationOp(
      deps({ importer: importerOf(recorder), artifacts }),
      "key",
      { kind: "PROVE" },
      "2026-06-01T00:00:00Z",
      undefined,
      { proof: artifactOf("proof-bytes") },
    );

    // The plugin sees a description of the body, never the body: `applyOp`
    // stays a pure function of (state, teamId, op).
    expect(out).toMatchObject({
      kind: "ok",
      projection: { refs: { proof: { artifactId: "artifact1", bytes: 11 } } },
    });
    expect(artifacts.stored.size).toBe(1);
  });

  it("should reject a malformed submission before storing anything", async () => {
    const artifacts = fakeArtifactStore();
    const out = await handleCoordinationOp(
      deps({ importer: importerOf(recorder), artifacts }),
      "key",
      { kind: "PROVE" },
      "2026-06-01T00:00:00Z",
      undefined,
      { proof: { contentType: "not-a-media-type", contentBase64: "aGk=" } },
    );

    expect(out).toEqual({ kind: "rejected", error: "invalid_artifact_content_type" });
    expect(artifacts.stored.size).toBe(0);
  });

  it("should withdraw a stored body when the plugin rejects the op", async () => {
    const artifacts = fakeArtifactStore();
    const out = await handleCoordinationOp(
      deps({ importer: importerOf(recorder), artifacts }),
      "key",
      { kind: "bad" },
      "2026-06-01T00:00:00Z",
      undefined,
      { proof: artifactOf("never-referenced") },
    );

    // The op never reached the state, so nothing references this object and no
    // teardown would ever find it.
    expect(out).toEqual({ kind: "rejected", error: "bad_op" });
    expect(artifacts.removed).toEqual(["artifact1"]);
    expect(artifacts.stored.size).toBe(0);
  });

  it("should treat a scope torn down mid-submission as an ended event", async () => {
    const artifacts = fakeArtifactStore();
    artifacts.scopeDeleted = true;
    const out = await handleCoordinationOp(
      deps({ importer: importerOf(recorder), artifacts }),
      "key",
      { kind: "PROVE" },
      "2026-06-01T00:00:00Z",
      undefined,
      { proof: artifactOf("in flight") },
    );

    expect(out).toEqual({ kind: "rejected", error: "event_ended" });
  });

  it("should leave an op with no artifacts entirely untouched", async () => {
    const artifacts = fakeArtifactStore();
    const out = await handleCoordinationOp(
      deps({ importer: importerOf(recorder), artifacts }),
      "key",
      { kind: "PROVE" },
      "2026-06-01T00:00:00Z",
    );

    // Most operations carry none, and they must not be made to say so.
    expect(out).toMatchObject({ kind: "ok", projection: { refs: null } });
    expect(artifacts.stored.size).toBe(0);
  });
});

describe("handleCoordinationArtifactFetch (#3152)", () => {
  /** A plugin whose projection carries whatever the state recorded. */
  const ledger = (refs: unknown): CoordinationPlugin<unknown, unknown, unknown> => ({
    initialState: () => ({}),
    validateOp: () => ({ ok: true }),
    applyOp: (s) => s,
    projectForTeam: () => ({ publicLedger: refs }),
  });

  async function seed(artifacts: ReturnType<typeof fakeArtifactStore>): Promise<string> {
    const stored = await artifacts.put(scope.state, {
      contentType: "application/octet-stream",
      content: new TextEncoder().encode("share-value"),
    });
    return stored.kind === "stored" ? stored.ref.artifactId : "";
  }

  it("should return the body when this team's projection references it", async () => {
    const artifacts = fakeArtifactStore();
    const artifactId = await seed(artifacts);

    const out = await handleCoordinationArtifactFetch(
      deps({ importer: importerOf(ledger([{ share: { artifactId } }])), artifacts }),
      "key",
      artifactId,
    );

    // This is what keeps HUNT working: the hunter fetches the bodies of the
    // shares they are actually hunting, at the moment they hunt.
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && new TextDecoder().decode(out.artifact.content)).toBe("share-value");
  });

  it("should refuse a body this team's projection does not reference", async () => {
    const artifacts = fakeArtifactStore();
    const artifactId = await seed(artifacts);

    // The plugin already decides what each team may see; reusing that decision
    // means the fetch cannot disagree with the board the participant sees.
    expect(
      await handleCoordinationArtifactFetch(
        deps({ importer: importerOf(ledger([])), artifacts }),
        "key",
        artifactId,
      ),
    ).toEqual({ kind: "not_found" });
  });

  it("should answer not_found for an artifact that does not exist", async () => {
    // Same answer as unauthorized, so a participant cannot probe which ids
    // exist in a match they cannot see.
    expect(
      await handleCoordinationArtifactFetch(
        deps({ importer: importerOf(ledger([{ share: { artifactId: "ghost" } }])) }),
        "key",
        "ghost",
      ),
    ).toEqual({ kind: "not_found" });
  });

  it("should pass the scope resolution through when there is no such match", async () => {
    expect(
      await handleCoordinationArtifactFetch(
        deps({ resolveScope: async () => ({ kind: "not_configured" as const }) }),
        "key",
        "anything",
      ),
    ).toEqual({ kind: "not_configured" });
  });

  it("should refuse rather than deny everything when the board cannot be built", async () => {
    const artifacts = fakeArtifactStore();
    const artifactId = await seed(artifacts);
    const v2: CoordinationPlugin<unknown, unknown, unknown> = {
      ...ledger([{ share: { artifactId } }]),
      stateSchemaVersion: 2,
      // A plugin declaring version 2 or above must carry a migration or it is
      // refused at load — which would produce the fallback projection and a
      // plain `not_found`, testing the wrong thing.
      migrateState: (state) => state,
    };

    const out = await handleCoordinationArtifactFetch(
      deps({
        importer: importerOf(v2),
        artifacts,
        // A row stamped by a plugin newer than the one now loaded.
        store: fakeStore({
          state: { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion: 3, state: {} },
          version: 1,
        }),
      }),
      "key",
      artifactId,
    );

    // Falling back to the empty projection would deny every artifact and look
    // exactly like the artifacts having gone.
    expect(out).toMatchObject({ kind: "schema_mismatch" });
  });
});
