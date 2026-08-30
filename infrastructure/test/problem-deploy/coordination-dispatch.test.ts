import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationContext, CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchCoordinationOp,
  projectCoordinationForTeam,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import {
  type CoordinationStoreDeps,
  deleteCoordinationState,
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
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
  return {
    store: {
      runtime: makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "Deployments",
    },
    send,
  };
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
    const store = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "Deployments",
    };
    await expect(
      writeCoordinationState(store, scope, {}, 0, "2026-06-01T00:00:00Z"),
    ).rejects.toThrow("ddb down");
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
    // version 0 condition (= 新規 row)。 [Issue #3133] 同じ partition に秘密の Put も走るので
    // state の item だけを見る。
    const put = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof PutCommand && c.input.Item?.SK === "STATE") as PutCommand;
    expect(put.input.ExpressionAttributeValues).toEqual({ ":expected": 0 });
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

  it("should surface a write conflict", async () => {
    const { store } = fakeStore({ getItem: undefined, conflict: true });
    const out = await dispatchCoordinationOp(store, counter, {
      ...base,
      op: { kind: "inc" },
      nowIso: "2026-06-01T00:00:00Z",
    });
    expect(out).toEqual({ kind: "conflict" });
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
    expect(projection).toEqual({ seed: `fallback:${ctx.eventId}` });
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should project with the issued secret once a match exists", async () => {
    const { store } = fakeStore({ getItem: undefined, matchSecret: "issued-by-first-op" });
    const { plugin } = seedRecorder();
    expect(await projectCoordinationForTeam(store, plugin, base)).toEqual({
      seed: "issued-by-first-op",
    });
  });
});

describe("projectCoordinationForTeam", () => {
  it("should project existing state without writing", async () => {
    const { store, send } = fakeStore({ getItem: { state: { count: 9 }, version: 1 } });
    expect(await projectCoordinationForTeam(store, counter, base)).toEqual({ count: 9 });
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false);
  });

  it("should project the initial state when uninitialized", async () => {
    const { store } = fakeStore({ getItem: undefined });
    expect(await projectCoordinationForTeam(store, counter, base)).toEqual({ count: 0 });
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
    ).toEqual({ count: -1 });
    expect(send).not.toHaveBeenCalled();
  });
});
