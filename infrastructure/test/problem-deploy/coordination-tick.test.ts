import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCoordinationTickBatch,
  type CollectedTickTarget,
  collectCoordinationTickTargets,
  createCoordinationTickPass,
  parseCoordinationProblemIds,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";
import type { CoordinationTickInvoker } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick-dispatch.js";

/**
 * scoring-driven tick (#2324) の **採点 pass 側**。資格情報分離のため、採点
 * Lambda は plugin を実行せず、 tick 対象を集めて CoordinationDispatcher Lambda を 1 回 async Invoke する。
 * collect の集約 / start gate、 event 相対 eventNowMs、 「coordination event が無ければ invoke しない」 no-op
 * を pin する。
 */

const CAPTURE_MS = 15 * 60 * 1000;
const NOW = "2026-06-01T01:00:00.000Z";
const STARTED = "2026-06-01T00:00:00.000Z";

describe("parseCoordinationProblemIds", () => {
  it("should return an empty set for undefined / invalid JSON / non-object / array", () => {
    expect(parseCoordinationProblemIds(undefined).size).toBe(0);
    expect(parseCoordinationProblemIds("{not json").size).toBe(0);
    expect(parseCoordinationProblemIds("42").size).toBe(0);
    expect(parseCoordinationProblemIds("[1,2]").size).toBe(0);
  });

  it("should return the declared problemId keys as a set", () => {
    const raw = JSON.stringify({ cap: { plugin: "coordination/x.ts" }, other: { plugin: "y.ts" } });
    expect(parseCoordinationProblemIds(raw)).toEqual(new Set(["cap", "other"]));
  });
});

describe("collectCoordinationTickTargets", () => {
  const IDS = new Set(["cap"]);
  const baseItem = () => ({
    tenantId: "t1",
    eventId: "e1",
    problemId: "cap",
    teamId: "team-a",
    eventStartsAt: STARTED,
  });

  it("should collect nothing when no problem declares coordination", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(new Set(), [baseItem()], out, NOW);
    expect(out.size).toBe(0);
  });

  it("should skip items missing tenant/event/problem/team", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [
        { ...baseItem(), tenantId: undefined },
        { ...baseItem(), eventId: undefined },
        { ...baseItem(), problemId: undefined },
        { ...baseItem(), teamId: undefined },
      ],
      out,
      NOW,
    );
    expect(out.size).toBe(0);
  });

  it("should skip a problem that does not declare coordination", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(IDS, [{ ...baseItem(), problemId: "other" }], out, NOW);
    expect(out.size).toBe(0);
  });

  it("should skip an event that has not started (missing or future eventStartsAt)", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [
        { ...baseItem(), eventStartsAt: undefined },
        { ...baseItem(), eventStartsAt: "2026-06-01T02:00:00.000Z" },
      ],
      out,
      NOW,
    );
    expect(out.size).toBe(0);
  });

  it("should skip an unparseable eventStartsAt (NaN epoch)", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [{ ...baseItem(), eventStartsAt: "0000-not-a-date" }],
      out,
      NOW,
    );
    expect(out.size).toBe(0);
  });

  it("should collect one target per event and accumulate distinct team ids", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [baseItem(), { ...baseItem(), teamId: "team-b" }, { ...baseItem(), teamId: "team-a" }],
      out,
      NOW,
    );
    expect(out.size).toBe(1);
    const t = out.get("t1#e1");
    expect(t?.moduleRef).toBe("cap");
    expect(t?.eventStartMs).toBe(Date.parse(STARTED));
    expect(t?.teamIds).toEqual(["team-a", "team-b"]);
  });

  it("should collect separate targets for distinct events", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(IDS, [baseItem(), { ...baseItem(), eventId: "e2" }], out, NOW);
    expect([...out.keys()].sort()).toEqual(["t1#e1", "t1#e2"]);
  });
});

describe("buildCoordinationTickBatch", () => {
  const target = (over: Partial<CollectedTickTarget> = {}): CollectedTickTarget => ({
    tenantId: "t1",
    eventId: "e1",
    moduleRef: "cap",
    eventStartMs: 1_000_000,
    teamIds: ["team-a"],
    ...over,
  });

  it("should compute event-relative eventNowMs (nowMs - eventStartMs), not wall clock", () => {
    const batch = buildCoordinationTickBatch([target()], 1_000_000 + CAPTURE_MS, NOW);
    expect(batch.action).toBe("coordination-tick");
    expect(batch.nowIso).toBe(NOW);
    expect(batch.targets).toEqual([
      {
        tenantId: "t1",
        eventId: "e1",
        moduleRef: "cap",
        eventNowMs: CAPTURE_MS,
        teamIds: ["team-a"],
      },
    ]);
  });

  it("should map every collected target", () => {
    const batch = buildCoordinationTickBatch(
      [target(), target({ eventId: "e2", eventStartMs: 0 })],
      2_000_000,
      NOW,
    );
    expect(batch.targets.map((t) => t.eventNowMs)).toEqual([1_000_000, 2_000_000]);
  });
});

describe("createCoordinationTickPass", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  const item = () => ({
    tenantId: "t1",
    eventId: "e1",
    problemId: "cap",
    teamId: "team-a",
    eventStartsAt: STARTED,
  });

  it("should invoke the dispatcher exactly once with the collected batch", async () => {
    const invoke = vi.fn<CoordinationTickInvoker>().mockResolvedValue(undefined);
    const pass = createCoordinationTickPass(invoke, "coord-dispatcher", new Set(["cap"]));
    pass.collect([item()], NOW);
    pass.collect([{ ...item(), teamId: "team-b" }], NOW); // second page, same event
    await pass.run(Date.parse(STARTED) + CAPTURE_MS, NOW);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [fnName, batch] = invoke.mock.calls[0];
    expect(fnName).toBe("coord-dispatcher");
    expect(batch.targets).toEqual([
      {
        tenantId: "t1",
        eventId: "e1",
        moduleRef: "cap",
        eventNowMs: CAPTURE_MS,
        teamIds: ["team-a", "team-b"],
      },
    ]);
  });

  it("should NOT invoke the dispatcher when no event declares coordination", async () => {
    const invoke = vi.fn<CoordinationTickInvoker>().mockResolvedValue(undefined);
    const pass = createCoordinationTickPass(invoke, "coord-dispatcher", new Set());
    pass.collect([item()], NOW); // problemId "cap" not in the (empty) declared set
    await pass.run(Date.parse(STARTED) + CAPTURE_MS, NOW);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("should NOT invoke when the dispatcher function name is unwired", async () => {
    const invoke = vi.fn<CoordinationTickInvoker>().mockResolvedValue(undefined);
    const pass = createCoordinationTickPass(invoke, "", new Set(["cap"]));
    pass.collect([item()], NOW);
    await pass.run(Date.parse(STARTED) + CAPTURE_MS, NOW);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("should swallow (warn, not throw) an invoke failure", async () => {
    const invoke = vi.fn<CoordinationTickInvoker>().mockRejectedValue(new Error("throttled"));
    const pass = createCoordinationTickPass(invoke, "coord-dispatcher", new Set(["cap"]));
    pass.collect([item()], NOW);
    await expect(pass.run(Date.parse(STARTED) + CAPTURE_MS, NOW)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("coordination tick dispatch failed"),
      { message: "throttled" },
    );
  });

  it("should stringify a non-Error invoke rejection in the warn", async () => {
    const invoke = vi.fn<CoordinationTickInvoker>().mockRejectedValue("plain fail");
    const pass = createCoordinationTickPass(invoke, "coord-dispatcher", new Set(["cap"]));
    pass.collect([item()], NOW);
    await expect(pass.run(Date.parse(STARTED) + CAPTURE_MS, NOW)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("coordination tick dispatch failed"),
      { message: "plain fail" },
    );
  });
});
