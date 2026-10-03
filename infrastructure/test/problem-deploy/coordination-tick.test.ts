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

  /**
   * [Issue #3123] The tick is what keeps a namespace's TTL alive, so it has to
   * stop when the event does. A finished event's deployment rows stay
   * `COMPLETE` until teardown, so gating on `eventStartsAt` alone kept ticking
   * a match that was already over -- extending its retention forever, and
   * advancing the state of any plugin that implements `tick` after scoring had
   * stopped. The gate is `isScoringActive`, the same predicate the scoring pass
   * uses.
   */
  it("should skip an event that has reached its explicit end", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [{ ...baseItem(), eventEndsAt: "2026-06-01T00:30:00.000Z" }],
      out,
      NOW,
    );
    expect(out.size).toBe(0);
  });

  /**
   * `#1421`'s liveness invariant: a round with no `eventEndsAt` still
   * terminates at `eventStartsAt + 30 days`, so an event whose end nobody set
   * cannot refresh its TTL forever either.
   */
  it("should skip an event past the liveness cap even with no eventEndsAt", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(IDS, [baseItem()], out, "2026-07-15T00:00:00.000Z");
    expect(out.size).toBe(0);
  });

  it("should still collect an event that is inside its window", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [{ ...baseItem(), eventEndsAt: "2026-06-01T09:00:00.000Z" }],
      out,
      NOW,
    );
    expect(out.size).toBe(1);
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

  /** [Issue #3123] The dedupe key is a JSON array of (tenant, event, problem). */
  const targetKey = (tenantId: string, eventId: string, problemId: string) =>
    JSON.stringify([tenantId, eventId, problemId]);

  it("should collect one target per event problem and accumulate distinct team ids", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      IDS,
      [baseItem(), { ...baseItem(), teamId: "team-b" }, { ...baseItem(), teamId: "team-a" }],
      out,
      NOW,
    );
    expect(out.size).toBe(1);
    const t = out.get(targetKey("t1", "e1", "cap"));
    expect(t?.moduleRef).toBe("cap");
    expect(t?.eventStartMs).toBe(Date.parse(STARTED));
    expect(t?.teamIds).toEqual(["team-a", "team-b"]);
  });

  it("should collect separate targets for distinct events", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(IDS, [baseItem(), { ...baseItem(), eventId: "e2" }], out, NOW);
    expect([...out.keys()].sort()).toEqual(
      [targetKey("t1", "e1", "cap"), targetKey("t1", "e2", "cap")].sort(),
    );
  });

  /**
   * [Issue #3123] The tick half of the namespace split. Keying by event alone
   * meant the second coordination problem in an event was silently dropped
   * from the batch — its clock never advanced, so no contract was ever issued
   * and the match never ended — while its teams were merged into the FIRST
   * problem's roster, putting teams into a state machine they were not playing.
   * Independent state without an independent clock is not independence.
   */
  it("should collect a separate target per coordination problem in one event", () => {
    const out = new Map<string, CollectedTickTarget>();
    collectCoordinationTickTargets(
      new Set(["cap", "sector"]),
      [
        baseItem(),
        { ...baseItem(), problemId: "sector", teamId: "team-z" },
        { ...baseItem(), problemId: "sector", teamId: "team-y" },
      ],
      out,
      NOW,
    );

    expect(out.size).toBe(2);
    expect(out.get(targetKey("t1", "e1", "cap"))?.teamIds).toEqual(["team-a"]);
    const sector = out.get(targetKey("t1", "e1", "sector"));
    expect(sector?.moduleRef).toBe("sector");
    expect(sector?.teamIds).toEqual(["team-z", "team-y"]);
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
