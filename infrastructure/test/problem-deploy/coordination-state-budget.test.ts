import { afterEach, describe, expect, it, vi } from "vitest";
import {
  budgetUsedPercent,
  checkCoordinationStateSize,
  COORDINATION_STATE_MAX_BYTES_ENV,
  coordinationStateBudget,
  serializedStateBytes,
} from "../../lib/problem-deploy/control-data/domain/coordination-budget";
import type { CoordinationStateScope } from "../../lib/problem-deploy/control-data/domain/coordination-scope";
import {
  COORDINATION_BUDGET_EXCEEDED_EVENT,
  COORDINATION_BUDGET_WARNING_EVENT,
  type CoordinationStoreDeps,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Issue #3151] The coordination state row had no size check at all: a match
 * grew until a write stopped being accepted, mid-tick, with no warning.
 *
 * These tests pin the three things the issue asks for, in the order it asks for
 * them: the platform (not the plugin) refuses the write, the ceiling moves when
 * the backend moves, and the warning is emitted where something can carry it to
 * an operator. The alarm wiring that does the carrying is pinned separately in
 * `ops-monitoring.test.ts`, against the synthesized template.
 */

const SCOPE: CoordinationStateScope = {
  tenantId: "tenant-a",
  eventId: "ev-1",
  problemId: "crypto-battle",
  runId: "default",
};

/** A state whose serialized form is at least `bytes` long. */
function stateOfBytes(bytes: number): { readonly padding: string } {
  // The envelope and the object syntax add a few dozen bytes on top, which is
  // why every assertion below compares against a threshold rather than an
  // exact size.
  return { padding: "x".repeat(bytes) };
}

/**
 * A store whose repository records the writes it was asked to make.
 *
 * The point of most of these tests is that the repository is NOT reached, so
 * the fake fails loudly on any call it did not expect rather than returning a
 * plausible success.
 */
function makeStore(env: Record<string, string | undefined> = {}): {
  readonly deps: CoordinationStoreDeps;
  readonly writes: unknown[];
} {
  const writes: unknown[] = [];
  const repository = {
    writeCoordinationState: (
      _scope: CoordinationStateScope,
      state: unknown,
    ): Promise<{ outcome: "updated" }> => {
      writes.push(state);
      return Promise.resolve({ outcome: "updated" as const });
    },
  };
  const runtime = makeTestControlDataRuntime(env);
  const deps: CoordinationStoreDeps = {
    runtime: {
      ...runtime,
      resolveDeploymentsRepository: () => Promise.resolve(repository as never),
    },
    ddb: { send: () => Promise.reject(new Error("unused")) } as never,
    tableName: "deployments",
  };
  return { deps, writes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coordinationStateBudget (#3151)", () => {
  it("should keep the DynamoDB ceiling below that service's 400KB item limit", () => {
    const budget = coordinationStateBudget({ kind: "dynamodb" });
    expect(budget.backend).toBe("dynamodb");
    // The reserve is the point: being refused by the platform is legible and
    // recoverable, being refused by DynamoDB mid-match is neither. A budget
    // that reached the raw limit would hand the match a write the backend then
    // rejects, which is exactly the failure this issue removes.
    expect(budget.maxBytes).toBeLessThan(400 * 1024);
    expect(budget.maxBytes).toBeGreaterThan(300 * 1024);
  });

  it("should give the SQL backend a ceiling that clears the platform's own worst case", () => {
    const budget = coordinationStateBudget({ kind: "pure" });
    expect(budget.backend).toBe("pure");
    // `ac26-crypto-battle` measures 1.62 MB at the platform's maximum roster
    // (99 teams). A Turso ceiling below that would forbid a match the backend
    // can serve perfectly well, which the issue calls out by name.
    expect(budget.maxBytes).toBeGreaterThan(1.62 * 1024 * 1024);
  });

  it("should change the ceiling when the backend changes", () => {
    const dynamo = coordinationStateBudget({ kind: "dynamodb" });
    const sql = coordinationStateBudget({ kind: "pure" });
    expect(sql.maxBytes).toBeGreaterThan(dynamo.maxBytes);
    expect(sql.warnBytes).toBeGreaterThan(dynamo.warnBytes);
  });

  it("should warn at half the ceiling on both backends", () => {
    for (const kind of ["dynamodb", "pure"] as const) {
      const budget = coordinationStateBudget({ kind });
      expect(budget.warnBytes).toBe(Math.floor(budget.maxBytes / 2));
    }
  });

  it("should honour a SQL ceiling override", () => {
    const budget = coordinationStateBudget(
      { kind: "pure" },
      { [COORDINATION_STATE_MAX_BYTES_ENV]: "123456" },
    );
    expect(budget.maxBytes).toBe(123456);
    expect(budget.warnBytes).toBe(61728);
  });

  it("should ignore the override on DynamoDB, whose ceiling is a service limit", () => {
    // Raising it past 400KB would not give the match more room; it would only
    // move the refusal from the platform back into the backend.
    const overridden = coordinationStateBudget(
      { kind: "dynamodb" },
      { [COORDINATION_STATE_MAX_BYTES_ENV]: `${64 * 1024 * 1024}` },
    );
    expect(overridden.maxBytes).toBe(coordinationStateBudget({ kind: "dynamodb" }).maxBytes);
  });

  it("should fail loudly on a malformed override rather than silently using the default", () => {
    // A typo here would otherwise restore the "no ceiling at all" state this
    // issue exists to remove, in exactly the environment whose operator
    // believed they had configured one.
    for (const bad of ["nonsense", "0", "-1", "1.5"]) {
      expect(() =>
        coordinationStateBudget({ kind: "pure" }, { [COORDINATION_STATE_MAX_BYTES_ENV]: bad }),
      ).toThrow(RangeError);
    }
  });
});

describe("serializedStateBytes (#3151)", () => {
  it("should measure UTF-8 bytes, not UTF-16 code units", () => {
    // Every problem in this catalog carries Japanese text. Measuring
    // `String.length` would under-report it threefold, and a ceiling measured
    // in the wrong unit is not a ceiling.
    const japanese = { label: "作戦盤面" };
    expect(JSON.stringify(japanese)?.length).toBe(16);
    expect(serializedStateBytes(japanese)).toBe(24);
  });

  it("should report unmeasurable for state JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializedStateBytes(cyclic)).toBeUndefined();
    expect(serializedStateBytes(undefined)).toBeUndefined();
  });
});

describe("classifyCoordinationStateSize (#3151)", () => {
  const budget = { backend: "dynamodb" as const, maxBytes: 1000, warnBytes: 500 };

  it("should classify by which line the size crossed", () => {
    expect(checkCoordinationStateSize("a".repeat(10), budget).kind).toBe("ok");
    expect(checkCoordinationStateSize("a".repeat(600), budget).kind).toBe("warn");
    expect(checkCoordinationStateSize("a".repeat(1200), budget).kind).toBe("exceeded");
  });

  it("should treat the warn line as inclusive and the ceiling as exclusive", () => {
    // Exactly at the ceiling still fits: the reserve above it is what covers
    // the gap between this measurement and the backend's own.
    expect(checkCoordinationStateSize("a".repeat(998), budget)).toMatchObject({
      kind: "warn",
      bytes: 1000,
    });
    expect(checkCoordinationStateSize("a".repeat(999), budget).kind).toBe("exceeded");
  });

  it("should report the used percentage for the operator's log line", () => {
    expect(budgetUsedPercent(500, budget)).toBe(50);
    expect(budgetUsedPercent(753, budget)).toBe(75.3);
  });
});

describe("writeCoordinationState budget enforcement (#3151)", () => {
  it("should write normally below the warning line, with no operator noise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, writes } = makeStore();
    return writeCoordinationState(deps, SCOPE, { turn: 1 }, 0, "2026-06-01T00:00:00.000Z").then(
      (outcome) => {
        expect(outcome).toEqual({ kind: "ok" });
        expect(writes).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
      },
    );
  });

  it("should refuse the write as a platform error before it reaches the backend", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, writes } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: "1024",
    });
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      stateOfBytes(4096),
      3,
      "2026-06-01T00:00:00.000Z",
    );
    expect(outcome.kind).toBe("too_large");
    // The issue's own acceptance criterion: the refusal happens in the
    // platform, not inside the plugin and not inside the backend. Nothing was
    // handed to the repository at all.
    expect(writes).toHaveLength(0);
  });

  it("should report the backend and ceiling on a refusal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: "1024",
    });
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      stateOfBytes(4096),
      3,
      "2026-06-01T00:00:00.000Z",
    );
    expect(outcome).toMatchObject({
      kind: "too_large",
      budget: { backend: "pure", maxBytes: 1024 },
    });
    expect(outcome.kind === "too_large" && outcome.bytes).toBeGreaterThan(4096);
  });

  it("should let the same state through on a backend with room for it", async () => {
    // The whole reason the budget is per-backend: this is not "the state is too
    // big", it is "this backend has no room for it".
    const { deps, writes } = makeStore({ CONTROL_DATA_BACKEND: "turso" });
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      stateOfBytes(4096),
      3,
      "2026-06-01T00:00:00.000Z",
    );
    expect(outcome).toEqual({ kind: "ok" });
    expect(writes).toHaveLength(1);
  });

  it("should emit the warning event before the ceiling, while still writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, writes } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: "8192",
    });
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      stateOfBytes(5000),
      3,
      "2026-06-01T00:00:00.000Z",
    );
    // Warning changes nothing about the write. That is the point: the operator
    // gets told while the match is still playable.
    expect(outcome).toEqual({ kind: "ok" });
    expect(writes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      event: COORDINATION_BUDGET_WARNING_EVENT,
      level: "warn",
      tenantId: "tenant-a",
      eventId: "ev-1",
      problemIds: "crypto-battle",
      backend: "pure",
      maxBytes: 8192,
    });
    expect(line.usedPercent).toBeGreaterThan(50);
  });

  it("should name the match in the warning without carrying its contents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: "8192",
    });
    await writeCoordinationState(
      deps,
      SCOPE,
      { secretPlan: "attack-at-dawn", padding: "x".repeat(5000) },
      3,
      "2026-06-01T00:00:00.000Z",
    );
    // An operator needs to know WHICH match is filling up. The bytes themselves
    // are the participants' game and must not end up in an operator log.
    const raw = String(warn.mock.calls[0]?.[0]);
    expect(raw).not.toContain("attack-at-dawn");
    expect(raw).not.toContain("xxxx");
  });

  it("should emit a distinct event when a write is actually refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: "1024",
    });
    await writeCoordinationState(deps, SCOPE, stateOfBytes(4096), 3, "2026-06-01T00:00:00.000Z");
    // Two events, not one: "heading for the ceiling" and "a match has stopped"
    // need different responses from whoever is woken up.
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.event).toBe(COORDINATION_BUDGET_EXCEEDED_EVENT);
    expect(COORDINATION_BUDGET_EXCEEDED_EVENT).not.toBe(COORDINATION_BUDGET_WARNING_EVENT);
  });

  it("should refuse state that cannot be serialized rather than passing it down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, writes } = makeStore();
    const cyclic: Record<string, unknown> = { turn: 1 };
    cyclic.self = cyclic;
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      cyclic,
      0,
      "2026-06-01T00:00:00.000Z",
    );
    // The backend would reject it too, later and less legibly. Refusing here
    // keeps the failure attributable.
    expect(outcome.kind).toBe("too_large");
    expect(outcome.kind === "too_large" && outcome.bytes).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it("should measure the stored envelope, not the plugin payload alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A payload that fits with nothing around it, but not once the platform's
    // own schema envelope is added. Measuring the payload would under-report by
    // exactly the bytes the platform itself writes.
    const payload = stateOfBytes(1000);
    const payloadBytes = serializedStateBytes(payload) ?? 0;
    const { deps, writes } = makeStore({
      CONTROL_DATA_BACKEND: "turso",
      [COORDINATION_STATE_MAX_BYTES_ENV]: `${payloadBytes + 10}`,
    });
    const outcome = await writeCoordinationState(
      deps,
      SCOPE,
      payload,
      0,
      "2026-06-01T00:00:00.000Z",
    );
    expect(outcome.kind).toBe("too_large");
    expect(writes).toHaveLength(0);
  });
});
