import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
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

/** GetCommand → getItem、 PutCommand → put 結果 (conflict 時は CCF を throw)。 */
function fakeStore(opts: {
  getItem?: Record<string, unknown>;
  conflict?: boolean;
  onPut?: (cmd: PutCommand) => void;
}): { store: CoordinationStoreDeps; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: opts.getItem };
    if (cmd instanceof DeleteCommand) return {};
    if (cmd instanceof PutCommand) {
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
  it("should delete the scoped row and the pre-scope row, and stay idempotent", async () => {
    const { store, send } = fakeStore({});
    await deleteCoordinationState(store, scope);
    await deleteCoordinationState(store, scope);
    const deleted = send.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => c.input.Key?.PK);
    expect(deleted).toEqual([
      "COORD#tn1#e1#problem-1#run-1",
      "COORD#tn1#e1",
      "COORD#tn1#e1#problem-1#run-1",
      "COORD#tn1#e1",
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
    // version 0 condition (= 新規 row)
    const put = send.mock.calls.map((c) => c[0]).find((c) => c instanceof PutCommand) as PutCommand;
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
    expect(send.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(false); // no write
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
