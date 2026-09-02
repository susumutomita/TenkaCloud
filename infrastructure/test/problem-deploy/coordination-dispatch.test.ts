import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationContext, CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository.js";
import type { ControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories.js";
import {
  backoffCeilingMs,
  dispatchCoordinationOp,
  projectCoordinationForTeam,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import {
  type CoordinationStoreDeps,
  deleteCoordinationState,
  readCoordinationState,
  touchCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

/**
 * Issue #1420: coordination state store + dispatcher orchestration の pin。
 * 既存 Deployments テーブル前提 (GetCommand / 条件付き PutCommand) を fake ddb で観測する。
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
const scope = {
  tenantId: "tn1",
  eventId: "e1",
  problemId: "problem-1",
  runId: "run-1",
} as const;
/**
 * [Issue #3164] Records the backoff calls instead of sleeping, so a test that
 * exercises the retry stays instant and can assert how many times it waited.
 */
function noSleep(attempts?: number) {
  const delays: number[] = [];
  return {
    ...(attempts === undefined ? {} : { attempts }),
    backoff: async (attempt: number) => {
      delays.push(attempt);
    },
    delays,
  };
}

/**
 * [Issue #3164] The coordination partition holds two items — `SK=STATE` and
 * `SK=MATCHSECRET` — and every fake in this file has to tell them apart before
 * it can answer. Naming it once keeps the fakes small enough to read.
 */
function isMatchSecretCommand(cmd: unknown): boolean {
  const keyed = cmd as {
    input?: { Key?: Record<string, unknown>; Item?: Record<string, unknown> };
  };
  return (keyed.input?.Key?.SK ?? keyed.input?.Item?.SK) === "MATCHSECRET";
}

/** Wraps a `send` double in the store shape `dispatchCoordinationOp` expects. */
function storeOver(send: (cmd: unknown) => Promise<unknown>): CoordinationStoreDeps {
  // Bound before the assertion, not asserted in place: `consistent-type-assertions`
  // wants a declaration it can annotate, and the DocumentClient surface is far
  // wider than the one method these doubles answer.
  const partial = { send };
  const ddb = partial as never;
  const store: CoordinationStoreDeps = {
    runtime: makeTestControlDataRuntime(),
    ddb,
    tableName: "Deployments",
  };
  return store;
}

const base = {
  scope,
  teamId: "t1",
  ctx,
  fallbackProjection: { count: -1 },
};

/**
 * GetCommand → getItem、 PutCommand → put 結果 (conflict 時は CCF を throw)。
 *
 * [Issue #3133] coordination partition は 2 item を持つ: `SK=STATE` (plugin state) と
 * `SK=MATCHSECRET` (server-only の試合秘密)。 fake も SK で分岐する — 分岐させないと、
 * state の conflict を模した fake が秘密の mint まで拒否してしまい、 実機には無い経路を
 * テストすることになる。 `matchSecret` 未指定なら秘密は未発行 (= 最初の op が発行する)。
 */
function fakeStore(opts: {
  getItem?: Record<string, unknown>;
  conflict?: boolean;
  onPut?: (cmd: PutCommand) => void;
  matchSecret?: string;
}): { store: CoordinationStoreDeps; send: ReturnType<typeof vi.fn> } {
  const secretItem = opts.matchSecret ? { matchSecret: opts.matchSecret } : undefined;
  const isSecret = (cmd: {
    input: { Key?: Record<string, unknown>; Item?: Record<string, unknown> };
  }) => (cmd.input.Key?.SK ?? cmd.input.Item?.SK) === "MATCHSECRET";
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: isSecret(cmd) ? secretItem : opts.getItem };
    if (cmd instanceof DeleteCommand) return {};
    if (cmd instanceof PutCommand) {
      if (isSecret(cmd)) return {};
      opts.onPut?.(cmd);
      if (opts.conflict) {
        throw new ConditionalCheckFailedException({ message: "ccf", $metadata: {} });
      }
      return {};
    }
    throw new Error("unexpected command");
  });
  return { store: storeOver(send), send };
}

describe("coordination-store", () => {
  it("should return undefined when the row does not exist", async () => {
    const { store } = fakeStore({ getItem: undefined });
    expect(await readCoordinationState(store, scope)).toBeUndefined();
  });

  it("should read state and default a missing version to 0", async () => {
    const { store } = fakeStore({ getItem: { state: { count: 3 } } });
    expect(await readCoordinationState(store, scope)).toEqual({
      state: { count: 3 },
      version: 0,
    });
  });

  it("should read the state consistently, because the write it feeds is conditional", async () => {
    // [Issue #3164] An eventually-consistent read can hand back a version that
    // is already stale, so the conditional write it feeds is refused for a
    // reason nothing in the request was wrong about — and the retry re-reads
    // and can be handed the same stale row again. Retrying is only worth doing
    // if the re-read can see the winner.
    const { store, send } = fakeStore({ getItem: { state: { count: 3 }, version: 4 } });
    await readCoordinationState(store, scope);
    const get = send.mock.calls.map((c) => c[0]).find((c) => c instanceof GetCommand) as GetCommand;
    expect(get.input.ConsistentRead).toBe(true);
  });

  it("should write with the version condition and bump the version", async () => {
    let captured: PutCommand | undefined;
    const { store } = fakeStore({ onPut: (cmd) => (captured = cmd) });
    const r = await writeCoordinationState(store, scope, { count: 1 }, 4, "2026-06-01T00:00:00Z");
    expect(r).toEqual({ kind: "ok" });
    expect(captured?.input.Item).toMatchObject({
      PK: "COORD#tn1#e1#problem-1#run-1",
      SK: "STATE",
      version: 5,
    });
    expect(captured?.input.ExpressionAttributeValues).toEqual({ ":expected": 4 });
  });

  /**
   * [Issue #3123] The bug this issue fixes: before the key carried problem and
   * run, every scope below wrote the SAME partition, so a second coordination
   * problem in one event silently overwrote the first one's match.
   */
  it("should give every problem and run in one event a distinct partition", async () => {
    const written: unknown[] = [];
    const { store } = fakeStore({ onPut: (cmd) => written.push(cmd.input.Item?.PK) });
    for (const target of [
      { ...scope, problemId: "problem-a", runId: "run-1" },
      { ...scope, problemId: "problem-b", runId: "run-1" },
      { ...scope, problemId: "problem-a", runId: "run-2" },
      { ...scope, eventId: "e2", problemId: "problem-a", runId: "run-1" },
      { ...scope, tenantId: "tn2", problemId: "problem-a", runId: "run-1" },
    ]) {
      await writeCoordinationState(store, target, { count: 1 }, 0, "2026-06-01T00:00:00Z");
    }
    expect(written).toEqual([
      "COORD#tn1#e1#problem-a#run-1",
      "COORD#tn1#e1#problem-b#run-1",
      "COORD#tn1#e1#problem-a#run-2",
      "COORD#tn1#e2#problem-a#run-1",
      "COORD#tn2#e1#problem-a#run-1",
    ]);
    expect(new Set(written).size).toBe(written.length);
  });

  /**
   * [Issue #3123] A `#` inside any component would let two different scopes
   * build one key — across the tenant boundary, so one tenant's state could be
   * served to another. Upstream id validation already forbids it; the key
   * builder fails closed rather than trusting that.
   */
  it("should refuse a key component carrying the delimiter", async () => {
    const { store, send } = fakeStore({});
    await expect(
      writeCoordinationState(
        store,
        { ...scope, tenantId: "tn1#e1#problem-a" },
        {},
        0,
        "2026-06-01T00:00:00Z",
      ),
    ).rejects.toThrow(/must not contain "#"/);
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * [Issue #3123] An empty component collapses two adjacent delimiters, so
   * `{problemId: "", runId: "a"}` and `{problemId: "a", runId: ""}`... would
   * differ, but `{eventId: "", problemId: "a#b"}` would not. More simply: an
   * empty dimension is never a real scope, and writing one would park state
   * where no honest read can find it again.
   */
  it.each([
    "tenantId",
    "eventId",
    "problemId",
    "runId",
  ] as const)("should refuse an empty %s", async (field) => {
    const { store, send } = fakeStore({});
    await expect(
      writeCoordinationState(store, { ...scope, [field]: "" }, {}, 0, "2026-06-01T00:00:00Z"),
    ).rejects.toThrow(new RegExp(`${field} must not be empty`));
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * [Issue #3123] The row's TTL is the retention backstop for a cleanup that
   * never ran, and every write refreshes it — so a live match never expires
   * under itself.
   */
  it("should stamp a refreshed TTL on every write", async () => {
    let captured: PutCommand | undefined;
    const { store } = fakeStore({ onPut: (cmd) => (captured = cmd) });
    await writeCoordinationState(store, scope, { count: 1 }, 0, "2026-06-01T00:00:00.000Z");
    const sevenDaysLater = Date.parse("2026-06-08T00:00:00.000Z") / 1000;
    expect(captured?.input.Item?.expiresAt).toBe(sevenDaysLater);
  });

  it("should refuse a write timestamp that is not an instant", async () => {
    const { store, send } = fakeStore({});
    await expect(writeCoordinationState(store, scope, {}, 0, "not-a-date")).rejects.toThrow(
      /not an ISO8601 instant/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * [Issue #3123] Deleting a namespace is the run-reset primitive, and it also
   * clears the pre-scope `COORD#<tenant>#<event>` row — those predate the TTL
   * attribute, so nothing else would ever reap them.
   */
  it("should delete the scoped row, the pre-scope row and the match secret, and stay idempotent", async () => {
    const { store, send } = fakeStore({});
    await deleteCoordinationState(store, scope);
    await deleteCoordinationState(store, scope);
    const deleted = send.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => `${c.input.Key?.PK}/${c.input.Key?.SK}`);
    // [Issue #3133] 秘密は state と同じ scope で消える。 残すと、 作り直された同名 scope が
    // 消えた試合の隠し材料を引き継いでしまう。
    expect(deleted).toEqual([
      "COORD#tn1#e1#problem-1#run-1/STATE",
      "COORD#tn1#e1/STATE",
      "COORD#tn1#e1#problem-1#run-1/MATCHSECRET",
      "COORD#tn1#e1#problem-1#run-1/STATE",
      "COORD#tn1#e1/STATE",
      "COORD#tn1#e1#problem-1#run-1/MATCHSECRET",
    ]);
  });

  it("should return conflict on a ConditionalCheckFailed", async () => {
    const { store } = fakeStore({ conflict: true });
    expect(await writeCoordinationState(store, scope, {}, 0, "2026-06-01T00:00:00Z")).toEqual({
      kind: "conflict",
    });
  });

  it("should rethrow non-conditional errors", async () => {
    const send = vi.fn(async () => {
      throw new Error("ddb down");
    });
    const store = storeOver(send);
    await expect(
      writeCoordinationState(store, scope, {}, 0, "2026-06-01T00:00:00Z"),
    ).rejects.toThrow("ddb down");
  });
});

/**
 * [Issue #3150] `coordination-store.ts` wraps / unwraps the schema-version
 * envelope with no idea which repository backend is underneath -- it only
 * ever touches `repository.state: unknown`. This pins that the wrap/unwrap
 * behaves identically against BOTH concrete repositories, the same way
 * `deployments-repository-parity.test.ts` pins parity for everything else in
 * this port.
 *
 * The DynamoDB side goes through the real `makeTestControlDataRuntime()`
 * resolver (default env = dynamodb) with `makeFakeDdb()`, so it exercises the
 * actual backend-selection path. The SQL side cannot: `makeTestControlDataRuntime`'s
 * `turso` branch needs a libSQL `Client` (SSM token fetch + HTTP `execute`/
 * `batch`), and this repo has no existing fake libSQL client bridging
 * `node:sqlite` faithfully -- building one from scratch for this test would be
 * new, unproven infrastructure. Constructing `SqlDeploymentsRepository`
 * directly on `makeSqliteExecutor()` (the same fake `deployments-repository-parity.test.ts`
 * uses) exercises the exact same repository code against a real SQLite
 * database instead; only the runtime-selection plumbing around it differs.
 */
const rtScope = { tenantId: "tn-rt", eventId: "ev-rt", problemId: "problem-rt", runId: "run-rt" };
/** The SQL-backed store never touches DynamoDB; any `send` is a test bug, not a fallback. */
const sqlBackendDdb = { send: () => Promise.reject(new Error("sql backend does not use ddb")) };
const backendStores: readonly (readonly [string, () => CoordinationStoreDeps])[] = [
  [
    "DynamoDbDeploymentsRepository",
    () => ({
      runtime: makeTestControlDataRuntime(),
      ddb: makeFakeDdb(),
      tableName: "Deployments",
    }),
  ],
  [
    "SqlDeploymentsRepository",
    () => {
      const sql = makeSqliteExecutor();
      // [Issue #3151] Built by overriding one method on a REAL runtime rather
      // than by casting an object literal. The store now also asks the runtime
      // for the backend's state size budget, and a hand-rolled stub silently
      // stops satisfying the interface the moment it grows a method -- the cast
      // hides that from the compiler, so the miss only shows up as a runtime
      // TypeError inside an unrelated assertion.
      return {
        runtime: {
          ...makeTestControlDataRuntime({ CONTROL_DATA_BACKEND: "turso" }),
          resolveDeploymentsRepository: async () => new SqlDeploymentsRepository(sql),
        } as unknown as ControlDataRuntime,
        ddb: sqlBackendDdb as never,
        tableName: "Deployments",
      };
    },
  ],
];

describe.each(backendStores)("coordination-store envelope round trip: %s", (_label, makeStore) => {
  it("should round-trip an enveloped write through read, surfacing stateSchemaVersion and the unwrapped state", async () => {
    const store = makeStore();
    await writeCoordinationState(store, rtScope, { count: 1 }, 0, "2026-06-01T00:00:00.000Z", 2);
    expect(await readCoordinationState(store, rtScope)).toEqual({
      state: { count: 1 },
      version: 1,
      stateSchemaVersion: 2,
      expiresAt: expect.any(Number),
    });
  });

  /**
   * A row written straight through the repository (as every row was before
   * this issue) carries no envelope. It must read back as the plugin's raw
   * state with `stateSchemaVersion: undefined` -- never as an error, and
   * never silently reset.
   */
  it("should read a pre-envelope row as stateSchemaVersion undefined with the raw state intact", async () => {
    const store = makeStore();
    const repository = await store.runtime.resolveDeploymentsRepository({
      ddb: store.ddb as never,
      deploymentsTableName: store.tableName,
    });
    await repository.writeCoordinationState(
      rtScope,
      { legacy: true },
      0,
      "2026-06-01T00:00:00.000Z",
      0,
    );
    const read = await readCoordinationState(store, rtScope);
    expect(read?.state).toEqual({ legacy: true });
    expect(read?.stateSchemaVersion).toBeUndefined();
  });

  /**
   * [Issue #3150] Codex review (P1): 版 1 の行は封筒を **被せない**。 封筒は旧 dispatcher が
   * 知らない形なので、 全行を封筒にすると「この版を deploy → 行に触る → 1 つ前の版に rollback」で
   * 旧 reader が封筒をそのまま plugin の state として渡してしまう。 版を宣言しない / 1 と宣言する
   * plugin -- 今日ある全 plugin -- の行が #3150 以前と同一であることが、 dispatcher rollback の
   * 安全性そのもの。 ここが落ちたらその保証が消えている。
   */
  it.each([
    ["the caller omits the version", undefined],
    ["the caller passes version 1", 1],
  ])("should write raw state with no envelope when %s", async (_label, declared) => {
    const store = makeStore();
    const args = [store, rtScope, { count: 7 }, 0, "2026-06-01T00:00:00.000Z"] as const;
    await (declared === undefined
      ? writeCoordinationState(...args)
      : writeCoordinationState(...args, declared));
    const repository = await store.runtime.resolveDeploymentsRepository({
      ddb: store.ddb as never,
      deploymentsTableName: store.tableName,
    });
    // 旧 dispatcher が見るのと同じ視点 -- 生の state であること。
    expect((await repository.readCoordinationState(rtScope))?.state).toEqual({ count: 7 });
    const read = await readCoordinationState(store, rtScope);
    expect(read?.state).toEqual({ count: 7 });
    expect(read?.stateSchemaVersion).toBeUndefined();
  });

  /**
   * [Issue #3150] Codex review: plugin の State は `unknown` なので、 旧 state がたまたま
   * marker key を持つことはあり得る。 marker 1 つで封筒と誤認すると `state.state` が undefined に
   * なって plugin に渡り、 500 か次の write での破壊になる。 形が完全に揃ったときだけ封筒。
   */
  it.each([
    ["only the marker", { __tenkacloudCoordinationEnvelope: 1 }],
    [
      "a non-integer version",
      { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion: "2", state: { count: 1 } },
    ],
    ["no state key", { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion: 2, mine: true }],
  ])("should treat legacy state with %s as raw state, not an envelope", async (_label, legacy) => {
    const store = makeStore();
    const repository = await store.runtime.resolveDeploymentsRepository({
      ddb: store.ddb as never,
      deploymentsTableName: store.tableName,
    });
    await repository.writeCoordinationState(rtScope, legacy, 0, "2026-06-01T00:00:00.000Z", 0);
    const read = await readCoordinationState(store, rtScope);
    expect(read?.state).toEqual(legacy);
    expect(read?.stateSchemaVersion).toBeUndefined();
  });

  /**
   * [Issue #3150] Codex review 2 巡目: 版 1 の plugin の生 state それ自体が封筒の形をしている
   * ことはあり得る (`State` は `unknown` で形の制約が無い)。 そのまま生で書くと次の read が必ず
   * 封筒と誤認して内側を剥き出す -- 毎回確実に壊れる。 封をすれば read が 1 枚剥いで元に戻る。
   */
  it("should seal a version-1 state that would otherwise be misread as an envelope", async () => {
    const store = makeStore();
    const looksLikeEnvelope = {
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 2,
      state: { mine: true },
    };
    await writeCoordinationState(store, rtScope, looksLikeEnvelope, 0, "2026-06-01T00:00:00.000Z");
    const read = await readCoordinationState(store, rtScope);
    expect(read?.state).toEqual(looksLikeEnvelope);
    expect(read?.stateSchemaVersion).toBe(1);
  });

  it("touchCoordinationState should not disturb the envelope", async () => {
    const store = makeStore();
    await writeCoordinationState(store, rtScope, { count: 5 }, 0, "2026-06-01T00:00:00.000Z", 3);
    await touchCoordinationState(store, rtScope, "2026-06-02T00:00:00.000Z");
    const read = await readCoordinationState(store, rtScope);
    expect(read?.state).toEqual({ count: 5 });
    expect(read?.version).toBe(1);
    expect(read?.stateSchemaVersion).toBe(3);
  });
});

describe("dispatchCoordinationOp", () => {
  it("should initialize, apply, persist, and project on a fresh event", async () => {
    const { store, send } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "ok", projection: { count: 1 } });
    // [Issue #3133] 同じ partition に秘密の Put も走るので state の item だけを見る。
    // [Issue #3126] 新規 row (expectedVersion 0) の条件は `attribute_not_exists(version)` 単独。
    // 以前の `... OR version = :expected` は、reset で消された直後の遅い op が row を
    // 復活させられてしまうため分割した。
    const put = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE") as PutCommand;
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(version)");
    expect(put.input.ExpressionAttributeValues).toBeUndefined();
  });

  it("should apply on top of existing state", async () => {
    const { store } = fakeStore({ getItem: { state: { count: 5 }, version: 2 } });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "ok", projection: { count: 6 } });
  });

  it("should reject an op that fails validateOp", async () => {
    const { store, send } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      op: { kind: "bad" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "rejected", error: "bad_op" });
    // 拒否された op は state を書かない。 [Issue #3133] 未初期化の試合では秘密だけは発行される
    // (`initialState` に渡すため) が、 それは孤児ではなく次に成功する op がそのまま採用する値。
    const statePuts = send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE");
    expect(statePuts).toEqual([]);
  });

  /**
   * [Issue #659] `teamScores` is a plugin's own code running on the accepted-op
   * path. The op is already committed when it runs, so a plugin bug there must
   * cost at most one scoreboard update — never the move the participant made.
   */
  // A plugin is third-party code and JavaScript lets it throw anything, so the
  // string case is not hypothetical — and a log line reading "undefined" is
  // useless in the middle of a match.
  it.each([
    ["an Error", new Error("plugin bug"), "plugin bug"],
    ["a bare string", "plugin bug", "plugin bug"],
  ])("should keep the op when the plugin's teamScores throws %s", async (_label, thrown, msg) => {
    const { store } = fakeStore({ getItem: undefined });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await dispatchCoordinationOp(
      store,
      {
        ...counter,
        teamScores: () => {
          throw thrown;
        },
      },
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
    );
    expect(out).toEqual({ kind: "ok", projection: { count: 1 } });
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: msg }),
    );
    warn.mockRestore();
  });

  it("should report no scores when the op moved nobody", async () => {
    // A plugin with an opinion about scores still writes nothing for an op that
    // changed none of them — the scoreboard is only touched when it is wrong.
    const { store } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(
      store,
      { ...counter, teamScores: () => ({ teamA: 0 }) },
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
    );
    expect(out).toEqual({ kind: "ok", projection: { count: 1 } });
  });

  it("should report only the teams whose score moved", async () => {
    const { store } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(
      store,
      { ...counter, teamScores: (s) => ({ teamA: s.count * 10, teamB: 0 }) },
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
    );
    // teamB sat still, so it is absent: an unchanged row is not rewritten.
    expect(out).toEqual({ kind: "ok", projection: { count: 1 }, changedScores: { teamA: 10 } });
  });

  it("should surface a write conflict once it has run out of attempts", async () => {
    const { store } = fakeStore({ getItem: undefined, conflict: true });
    const out = await dispatchCoordinationOp(
      store,
      counter,
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
      noSleep(),
    );
    expect(out).toEqual({ kind: "conflict" });
  });
});

/**
 * [Issue #3164] Losing a race on the shared row must not lose the move.
 *
 * A match is one row that every op rewrites under a version condition, and
 * Orders land for every team at the same instant, so contention is the normal
 * case rather than the exception once a match has more than a handful of teams.
 * Before this, the loser got `conflict`, which the portal shows as a generic
 * infrastructure error with the move discarded — the participant pressed a
 * button and nothing happened.
 */
describe("dispatchCoordinationOp write contention", () => {
  /**
   * Conflicts on the first `times` writes, then accepts.
   *
   * `readState` is handed the number of writes already attempted, so a test can
   * make the row it hands back depend on how far the retry has got — which is
   * how "the match moved on between attempts" is expressed.
   */
  function flakyStore(times: number, readState?: (writes: number) => Record<string, unknown>) {
    let writes = 0;
    const reads: number[] = [];
    const send = vi.fn(async (cmd: unknown) => {
      if (isMatchSecretCommand(cmd)) return { Item: undefined };
      if (cmd instanceof GetCommand) {
        reads.push(writes);
        return { Item: readState?.(writes) };
      }
      if (!(cmd instanceof PutCommand)) throw new Error("unexpected command");
      writes += 1;
      if (writes <= times) {
        throw new ConditionalCheckFailedException({ message: "ccf", $metadata: {} });
      }
      return {};
    });
    return { store: storeOver(send), reads, writes: () => writes };
  }

  it("should land the move when a later attempt wins the row", async () => {
    const { store, writes } = flakyStore(2);
    const sleeps = noSleep();
    const out = await dispatchCoordinationOp(
      store,
      counter,
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
      sleeps,
    );
    expect(out).toEqual({ kind: "ok", projection: { count: 1 } });
    expect(writes()).toBe(3);
    // Backed off between attempts, and not after the one that succeeded.
    expect(sleeps.delays).toEqual([0, 1]);
  });

  it("should re-read the row on every attempt, not replay the first read", async () => {
    // The retry exists to re-decide against what is there NOW. A retry that
    // re-wrote the state it computed the first time would silently overwrite
    // whatever the winner of the race had just written.
    const { store, reads } = flakyStore(2);
    await dispatchCoordinationOp(
      store,
      counter,
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
      noSleep(),
    );
    expect(reads).toEqual([0, 1, 2]);
  });

  it("should reject on a retry when the op is no longer legal", async () => {
    // Between the two attempts the match moved on. `validateOp` runs again
    // against the row that was actually read, so a move the rules no longer
    // allow comes back as a rejection rather than being forced through.
    // The first read sees an open match; every later read sees it closed.
    const { store } = flakyStore(99, (writes) => ({
      state: { count: 0, closed: writes > 0 },
      version: writes,
    }));
    const closable: CoordinationPlugin<
      { count: number; closed?: boolean },
      { kind: "inc" },
      unknown
    > = {
      initialState: () => ({ count: 0 }),
      validateOp: (state) => (state.closed ? { ok: false, error: "match_closed" } : { ok: true }),
      applyOp: (state) => ({ ...state, count: state.count + 1 }),
      projectForTeam: (state) => ({ count: state.count }),
    };
    const out = await dispatchCoordinationOp(
      store,
      closable,
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
      noSleep(),
    );
    expect(out).toEqual({ kind: "rejected", error: "match_closed" });
  });

  it("should not retry a rejection", async () => {
    // Only a lost race is worth trying again. Re-running a move the rules
    // refused would just refuse it four more times, at the participant's cost.
    const { store, writes } = flakyStore(0);
    const sleeps = noSleep();
    const out = await dispatchCoordinationOp(
      store,
      counter,
      { ...base, op: { kind: "bad" }, nowIso: "2026-06-01T00:00:00Z" },
      sleeps,
    );
    expect(out).toEqual({ kind: "rejected", error: "bad_op" });
    expect(writes()).toBe(0);
    expect(sleeps.delays).toEqual([]);
  });

  it("should double the backoff window on each retry", () => {
    expect([0, 1, 2, 3].map(backoffCeilingMs)).toEqual([25, 50, 100, 200]);
  });

  it("should wait inside that window by default, with nothing injected", async () => {
    // The default path, which every other test here replaces. Full jitter is
    // what keeps twenty teams from being released together after one collision
    // and colliding again as a group; a fixed delay would just move the wave.
    // Advancing by each attempt's ceiling is enough whatever the draw was, so
    // this pins the wiring and the bound without asserting on the draw itself.
    vi.useFakeTimers();
    try {
      const { store } = flakyStore(2);
      const pending = dispatchCoordinationOp(store, counter, {
        ...base,
        op: { kind: "inc" },
        nowIso: "2026-06-01T00:00:00Z",
      });
      await vi.advanceTimersByTimeAsync(backoffCeilingMs(0));
      await vi.advanceTimersByTimeAsync(backoffCeilingMs(1));
      expect(await pending).toEqual({ kind: "ok", projection: { count: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("should stop after the configured number of attempts", async () => {
    // Bounded because the participant is waiting on this response: a retry that
    // never gives up turns a contended row into a queue that outlives the Lambda.
    const { store, writes } = flakyStore(99);
    const sleeps = noSleep(3);
    const out = await dispatchCoordinationOp(
      store,
      counter,
      { ...base, op: { kind: "inc" }, nowIso: "2026-06-01T00:00:00Z" },
      sleeps,
    );
    expect(out).toEqual({ kind: "conflict" });
    expect(writes()).toBe(3);
    expect(sleeps.delays).toEqual([0, 1]);
  });
});

/**
 * [Issue #3133] The whole point of the secret: a plugin that needs unguessable
 * material must be able to get it from the platform instead of seeding from
 * `eventId`, which the portal hands to the participant's own browser.
 */
describe("match secret in the plugin context", () => {
  /** Records the ctx `initialState` was called with, so the test can inspect it. */
  function seedRecorder(): {
    plugin: CoordinationPlugin<{ seed: string }, CounterOp, { seed: string }>;
    seen: CoordinationContext[];
  } {
    const seen: CoordinationContext[] = [];
    return {
      seen,
      plugin: {
        initialState: (c) => {
          seen.push(c);
          return { seed: c.matchSecret ?? `fallback:${c.eventId}` };
        },
        validateOp: (_s, _t, op) =>
          op.kind === "bad" ? { ok: false, error: "bad_op" } : { ok: true },
        applyOp: (s) => s,
        projectForTeam: (s) => ({ seed: s.seed }),
      },
    };
  }

  it("should hand initialState a minted secret that is not the eventId", async () => {
    const { store } = fakeStore({ getItem: undefined });
    const { plugin, seen } = seedRecorder();
    await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(seen).toHaveLength(1);
    const secret = seen[0]?.matchSecret;
    expect(secret).toBeDefined();
    expect(secret).not.toBe(ctx.eventId);
    // 32 bytes of entropy, hex-encoded. A short or低エントロピーな値は、 公開されている
    // 導出関数と組み合わせると総当たりできてしまう。
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should reuse the stored secret instead of minting a second one", async () => {
    const { store } = fakeStore({ getItem: undefined, matchSecret: "already-issued" });
    const { plugin, seen } = seedRecorder();
    await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(seen[0]?.matchSecret).toBe("already-issued");
  });

  it("should not touch the secret at all once the match has state", async () => {
    const { store, send } = fakeStore({ getItem: { state: { seed: "s" }, version: 3 } });
    const { plugin } = seedRecorder();
    await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    // `initialState` is the only hook that receives ctx, so an established
    // match needs no secret — and must not pay a read or a write for one.
    const secretCalls = send.mock.calls
      .map(
        (c) =>
          c[0] as { input?: { Key?: Record<string, unknown>; Item?: Record<string, unknown> } },
      )
      .filter((c) => (c.input?.Key?.SK ?? c.input?.Item?.SK) === "MATCHSECRET");
    expect(secretCalls).toEqual([]);
  });

  it("should never mint on the read-only projection path", async () => {
    const { store, send } = fakeStore({ getItem: undefined });
    const { plugin, seen } = seedRecorder();
    const projection = await projectCoordinationForTeam(store, plugin, base);
    // Polling must not write, and must not hand out a secret for a match that
    // may never start — the plugin sees no secret and falls back.
    expect(seen[0]?.matchSecret).toBeUndefined();
    expect(projection).toEqual({ kind: "ok", projection: { seed: `fallback:${ctx.eventId}` } });
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should project with the issued secret once a match exists", async () => {
    const { store } = fakeStore({ getItem: undefined, matchSecret: "issued-by-first-op" });
    const { plugin } = seedRecorder();
    expect(await projectCoordinationForTeam(store, plugin, base)).toEqual({
      kind: "ok",
      projection: { seed: "issued-by-first-op" },
    });
  });
});

describe("projectCoordinationForTeam", () => {
  it("should project existing state without writing", async () => {
    const { store, send } = fakeStore({ getItem: { state: { count: 9 }, version: 1 } });
    expect(await projectCoordinationForTeam(store, counter, base)).toEqual({
      kind: "ok",
      projection: { count: 9 },
    });
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should project the initial state when uninitialized", async () => {
    const { store } = fakeStore({ getItem: undefined });
    expect(await projectCoordinationForTeam(store, counter, base)).toEqual({
      kind: "ok",
      projection: { count: 0 },
    });
  });
});

describe("coordination context guard (#1420 review)", () => {
  it("should reject a dispatch when ctx.eventId differs from the persisted eventId", async () => {
    const { store, send } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      ctx: { eventId: "OTHER", teamIds: ["t1"] },
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "rejected", error: "context_mismatch" });
    expect(send).not.toHaveBeenCalled(); // fail-fast: no read/write
  });

  it("should reject a dispatch when the team is not in ctx.teamIds", async () => {
    const { store } = fakeStore({ getItem: undefined });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      teamId: "intruder",
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "rejected", error: "context_mismatch" });
  });

  it("should return the fallback projection on an inconsistent context", async () => {
    const { store, send } = fakeStore({ getItem: { state: { count: 9 }, version: 1 } });
    expect(
      await projectCoordinationForTeam(store, counter, { ...base, teamId: "intruder" }),
    ).toEqual({ kind: "ok", projection: { count: -1 } });
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * [Issue #3150] The Issue's own incident, replayed at the dispatch layer: a
 * plugin's state shape changed with no version to gate it, and new code read
 * old rows unconditionally -- three of the four ways that broke were silent
 * (`NaN`, a stalled distribution, another `NaN`), not a throw. These pin the
 * one rule that closes it (`reconcileStateSchema`, via `dispatchCoordinationOp`
 * / `projectCoordinationForTeam`): a version difference is either migrated
 * with a real, non-`NaN` value, or the request is refused -- the row is never
 * silently reset and never silently read as the wrong shape.
 */
describe("dispatch schema reconciliation (Issue #3150)", () => {
  /** v1 shape: what every row looked like before this issue. */
  interface CounterStateV1 {
    readonly count: number;
  }
  /** v2 shape: a field (`bonus`) the v1 rows never had. */
  interface CounterStateV2 {
    readonly count: number;
    readonly bonus: number;
  }

  function migratableCounter(
    migrateState?: (state: unknown, fromVersion: number) => CounterStateV2,
  ): CoordinationPlugin<CounterStateV2, CounterOp, { count: number; bonus: number }> {
    return {
      stateSchemaVersion: 2,
      // Omitted (not `undefined`) when absent: the loader gate and `reconcileStateSchema`
      // both key off `typeof migrateState === "function"`, and `[#3]` needs a plugin that
      // truly lacks the hook, not one that carries it as `undefined`.
      ...(migrateState ? { migrateState } : {}),
      initialState: () => ({ count: 0, bonus: 0 }),
      validateOp: (_s, _t, op) =>
        op.kind === "bad" ? { ok: false, error: "bad_op" } : { ok: true },
      applyOp: (s) => ({ count: s.count + 1, bonus: s.bonus + 1 }),
      projectForTeam: (s) => ({ count: s.count, bonus: s.bonus }),
    };
  }

  // The Issue's actual failure mode: a v1 row never had `bonus`, so reading
  // it as v2 without a migration reads `bonus` as `undefined` -- exactly the
  // "missing field -> NaN / silently stalled" pattern the four incidents
  // shared. `migrateState` defaults it explicitly instead.
  const defaultBonusMigration = vi.fn((state: unknown, _fromVersion: number): CounterStateV2 => {
    const legacy = state as CounterStateV1;
    return { count: legacy.count, bonus: 0 };
  });

  const envelopeItem = (stateSchemaVersion: number, state: unknown, version = 1) => ({
    state: { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion, state },
    version,
  });

  it("[#1] should migrate a pre-envelope (v1) row for a v2 plugin, apply the op on the migrated state, and persist a v2 envelope with real values (not NaN/undefined)", async () => {
    defaultBonusMigration.mockClear();
    let captured: PutCommand | undefined;
    const plugin = migratableCounter(defaultBonusMigration);
    const { store } = fakeStore({
      // A pre-#3150 row: raw state, no envelope at all.
      getItem: { state: { count: 5 }, version: 3 },
      onPut: (cmd) => (captured = cmd),
    });

    const out = await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });

    expect(defaultBonusMigration).toHaveBeenCalledWith({ count: 5 }, 1);
    expect(out).toEqual({ kind: "ok", projection: { count: 6, bonus: 1 } });
    expect(Number.isNaN((out as { projection: { bonus: number } }).projection.bonus)).toBe(false);
    const put = captured?.input.Item as { state: unknown; version: number };
    expect(put.state).toEqual({
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 2,
      state: { count: 6, bonus: 1 },
    });
    expect(put.version).toBe(4);
  });

  it("[#2] should refuse a v3 row for a v2 plugin (newer_row), leaving the row and initialState untouched", async () => {
    const initialStateSpy = vi.fn(() => ({ count: 0, bonus: 0 }));
    const plugin = { ...migratableCounter(defaultBonusMigration), initialState: initialStateSpy };
    const { store, send } = fakeStore({
      getItem: envelopeItem(3, { count: 9, bonus: 4 }),
    });

    const out = await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });

    expect(out).toEqual({ kind: "schema_mismatch", reason: "newer_row" });
    expect(initialStateSpy).not.toHaveBeenCalled();
    const statePuts = send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE");
    expect(statePuts).toEqual([]);
  });

  it("[#3] should refuse a pre-envelope row for a v2 plugin with no migrateState (missing_migration), without a write", async () => {
    const noMigratePlugin = migratableCounter();
    const { store, send } = fakeStore({ getItem: { state: { count: 5 }, version: 1 } });

    const out = await dispatchCoordinationOp(store, noMigratePlugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });

    expect(out).toEqual({ kind: "schema_mismatch", reason: "missing_migration" });
    const statePuts = send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE");
    expect(statePuts).toEqual([]);
  });

  it("[#4] should refuse a row whose migrateState throws (migration_failed), without a write", async () => {
    const plugin = migratableCounter(() => {
      throw new Error("cannot migrate this shape");
    });
    const { store, send } = fakeStore({ getItem: { state: { count: 5 }, version: 1 } });

    const out = await dispatchCoordinationOp(store, plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });

    expect(out).toEqual({
      kind: "schema_mismatch",
      reason: "migration_failed",
      detail: "cannot migrate this shape",
    });
    const statePuts = send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE");
    expect(statePuts).toEqual([]);
  });

  it("[#5a] projection should return schema_mismatch (not the fallback) for a newer row than the plugin declares", async () => {
    const plugin = migratableCounter(defaultBonusMigration);
    const { store, send } = fakeStore({ getItem: envelopeItem(3, { count: 9, bonus: 4 }) });

    const out = await projectCoordinationForTeam(store, plugin, {
      ...base,
      fallbackProjection: { count: -1, bonus: -1 },
    });

    expect(out).toEqual({ kind: "schema_mismatch", reason: "newer_row" });
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("[#5b] projection should return a migrated projection for a pre-envelope row without writing (version unchanged)", async () => {
    defaultBonusMigration.mockClear();
    const plugin = migratableCounter(defaultBonusMigration);
    const { store, send } = fakeStore({ getItem: { state: { count: 5 }, version: 3 } });

    const out = await projectCoordinationForTeam(store, plugin, {
      ...base,
      fallbackProjection: { count: -1, bonus: -1 },
    });

    expect(out).toEqual({ kind: "ok", projection: { count: 5, bonus: 0 } });
    expect(defaultBonusMigration).toHaveBeenCalledWith({ count: 5 }, 1);
    // Read path: no write at all, so the persisted version cannot have moved.
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("[#6] should not lose the match: once a compatible (v3) plugin is loaded, the SAME row the v2 plugin was refused on continues from its own state", async () => {
    const v3Plugin: CoordinationPlugin<
      { count: number; bonus: number; tier: string },
      CounterOp,
      { count: number; bonus: number; tier: string }
    > = {
      stateSchemaVersion: 3,
      initialState: () => ({ count: 0, bonus: 0, tier: "bronze" }),
      validateOp: (_s, _t, op) =>
        op.kind === "bad" ? { ok: false, error: "bad_op" } : { ok: true },
      applyOp: (s) => ({ ...s, count: s.count + 1, bonus: s.bonus + 1 }),
      projectForTeam: (s) => s,
    };
    // The exact row test [#2] was refused on.
    const { store } = fakeStore({ getItem: envelopeItem(3, { count: 9, bonus: 4, tier: "gold" }) });

    const out = await dispatchCoordinationOp(store, v3Plugin, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });

    // Carried forward from count=9, NOT reset to initialState's count=0.
    expect(out).toEqual({ kind: "ok", projection: { count: 10, bonus: 5, tier: "gold" } });
  });

  it("[#7] should not fold a schema mismatch into a 200 projection (the polled-most path must not lie)", async () => {
    const plugin = migratableCounter(defaultBonusMigration);
    const { store } = fakeStore({ getItem: envelopeItem(3, { count: 9, bonus: 4 }) });

    const out = await projectCoordinationForTeam(store, plugin, {
      ...base,
      fallbackProjection: { count: -1, bonus: -1 },
    });

    expect(out.kind).toBe("schema_mismatch");
    expect(out).not.toEqual({ kind: "ok", projection: { count: -1, bonus: -1 } });
  });
});
