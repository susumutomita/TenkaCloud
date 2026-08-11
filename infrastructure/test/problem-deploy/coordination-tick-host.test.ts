import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

interface FakeDdb {
  readonly store: CoordinationStoreDeps;
  readonly puts: { PK: string; state: unknown; version: number }[];
  readonly send: ReturnType<typeof vi.fn>;
}
function fakeDdb(opts: {
  getItem?: Record<string, unknown>;
  conflict?: boolean;
  getThrows?: boolean;
}): FakeDdb {
  const puts: { PK: string; state: unknown; version: number }[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      if (opts.getThrows) throw new Error("get boom");
      return { Item: opts.getItem };
    }
    if (cmd instanceof PutCommand) {
      if (opts.conflict) throw new ConditionalCheckFailedException({ $metadata: {}, message: "x" });
      const input = cmd.input as { Item: { PK: string; state: unknown; version: number } };
      puts.push({ PK: input.Item.PK, state: input.Item.state, version: input.Item.version });
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
    puts,
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
const batch = (
  targets: CoordinationTickBatch["targets"],
  nowIso = "2026-06-01T01:00:00.000Z",
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
    expect(ddb.puts).toEqual([{ PK: "COORD#t1#e1", state: { phase: "locked" }, version: 3 }]);
  });

  it("should NOT write when the tick is a no-op (before the window)", async () => {
    const ddb = fakeDdb({ getItem: { state: { phase: "open" }, version: 1 } });
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), ddb.store),
      batch([capTarget({ eventNowMs: CAPTURE_MS - 1 })]),
    );
    expect(res).toEqual({ ticked: 1, written: 0 });
    expect(ddb.puts).toHaveLength(0);
    expect(ddb.send).toHaveBeenCalledTimes(1); // read only, no write
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
    expect(ddb.puts).toEqual([{ PK: "COORD#t1#e1", state: { phase: "locked" }, version: 1 }]);
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
    const puts: string[] = [];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const key = (cmd.input as { Key: { PK: string } }).Key.PK;
        if (key === "COORD#t1#e1") throw new Error("get boom");
        return { Item: { state: { phase: "open" }, version: 0 } };
      }
      if (cmd instanceof PutCommand) {
        puts.push((cmd.input as { Item: { PK: string } }).Item.PK);
        return {};
      }
      throw new Error("unexpected");
    });
    const store: CoordinationStoreDeps = {
      runtime: makeTestControlDataRuntime(),
      ddb: { send } as never,
      tableName: "Deployments",
    };
    const res = await handleCoordinationTickBatch(
      depsWith(importerOf(windowPlugin), store),
      batch([capTarget(), capTarget({ eventId: "e2" })]),
    );
    expect(res.ticked).toBe(2);
    expect(res.written).toBe(1);
    expect(puts).toEqual(["COORD#t1#e2"]);
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
