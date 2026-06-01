import { describe, expect, it } from "vitest";
import {
  evaluateDisruptionTriggers,
  triggerMatches,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/disruption-triggers";
import {
  type PhaseEntry,
  parseScoringState,
  resolveActivePhase,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import {
  type DisruptionTrigger,
  type ProblemDisruptionEntry,
  parseDisruptionsCatalogEnv,
  parseDisruptionTriggers,
} from "../../lib/utils/discover-problems-catalog";

/**
 * #1422 (ADR-013 Phase 2): condition-triggered disruption の純粋ロジックを pin する。
 * - catalog の triggers[] / env パース
 * - trigger 単体判定 + OR 評価 + idempotency 抑制 + phase 解決
 * - scoringState の firedDisruptions persist / parse + resolveActivePhase 共有
 */

const baseDisruption = (over: Partial<ProblemDisruptionEntry> = {}): ProblemDisruptionEntry => ({
  id: "latency",
  name: "EC2 latency",
  eventDetailType: "DegradedDisruptionFired",
  parameters: { delayMs: 200 },
  ...over,
});

describe("parseDisruptionTriggers", () => {
  it("should parse the three supported trigger kinds and drop unknown / malformed", () => {
    const parsed = parseDisruptionTriggers([
      { kind: "after-deploy", afterMinutes: 60 },
      { kind: "team-score-above", threshold: 5000 },
      { kind: "phase-entered", phaseName: "degraded" },
      { kind: "after-deploy" }, // missing afterMinutes → drop
      { kind: "team-score-above", threshold: "nope" }, // wrong type → drop
      { kind: "unknown-kind", x: 1 }, // unknown → drop
      "not-an-object",
    ]);
    expect(parsed).toEqual([
      { kind: "after-deploy", afterMinutes: 60 },
      { kind: "team-score-above", threshold: 5000 },
      { kind: "phase-entered", phaseName: "degraded" },
    ]);
  });

  it("should return undefined for a non-array or all-invalid input", () => {
    expect(parseDisruptionTriggers(undefined)).toBeUndefined();
    expect(parseDisruptionTriggers("x")).toBeUndefined();
    expect(parseDisruptionTriggers([{ kind: "bogus" }])).toBeUndefined();
  });
});

describe("parseDisruptionsCatalogEnv", () => {
  it("should parse a serialized catalog env", () => {
    const env = JSON.stringify({
      p1: [baseDisruption({ triggers: [{ kind: "after-deploy", afterMinutes: 1 }] })],
    });
    const parsed = parseDisruptionsCatalogEnv(env);
    expect(parsed.p1?.[0]?.triggers?.[0]).toEqual({ kind: "after-deploy", afterMinutes: 1 });
  });

  it("should return an empty map for unset / malformed / non-object JSON", () => {
    expect(parseDisruptionsCatalogEnv(undefined)).toEqual({});
    expect(parseDisruptionsCatalogEnv("{not json")).toEqual({});
    expect(parseDisruptionsCatalogEnv("[]")).toEqual({});
    expect(parseDisruptionsCatalogEnv("null")).toEqual({});
  });
});

describe("triggerMatches", () => {
  const ctx = { scoreAfter: 100, elapsedMin: 30, phases: [] as readonly PhaseEntry[] };
  it("should match after-deploy when elapsed >= afterMinutes", () => {
    expect(triggerMatches({ kind: "after-deploy", afterMinutes: 30 }, ctx, undefined)).toBe(true);
    expect(triggerMatches({ kind: "after-deploy", afterMinutes: 31 }, ctx, undefined)).toBe(false);
  });
  it("should match team-score-above strictly above the threshold", () => {
    expect(triggerMatches({ kind: "team-score-above", threshold: 99 }, ctx, undefined)).toBe(true);
    expect(triggerMatches({ kind: "team-score-above", threshold: 100 }, ctx, undefined)).toBe(
      false,
    );
  });
  it("should match phase-entered only on the active phase name", () => {
    const t: DisruptionTrigger = { kind: "phase-entered", phaseName: "degraded" };
    expect(triggerMatches(t, ctx, "degraded")).toBe(true);
    expect(triggerMatches(t, ctx, "normal")).toBe(false);
    expect(triggerMatches(t, ctx, undefined)).toBe(false);
  });
});

describe("evaluateDisruptionTriggers", () => {
  const phases: readonly PhaseEntry[] = [
    { name: "normal", afterMinutes: 0 },
    { name: "degraded", afterMinutes: 20 },
  ];

  it("should fire a disruption whose score trigger is satisfied (OR semantics)", () => {
    const d = baseDisruption({
      triggers: [
        { kind: "after-deploy", afterMinutes: 999 }, // not yet
        { kind: "team-score-above", threshold: 50 }, // satisfied
      ],
    });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 100, elapsedMin: 5, phases },
      new Set(),
    );
    expect(fired).toEqual([
      {
        disruptionId: "latency",
        eventDetailType: "DegradedDisruptionFired",
        parameters: { delayMs: 200 },
        triggerKind: "team-score-above",
      },
    ]);
  });

  it("should fire on phase-entered using the active phase", () => {
    const d = baseDisruption({ triggers: [{ kind: "phase-entered", phaseName: "degraded" }] });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 0, elapsedMin: 25, phases },
      new Set(),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.triggerKind).toBe("phase-entered");
  });

  it("should skip disruptions already fired (idempotency)", () => {
    const d = baseDisruption({ triggers: [{ kind: "team-score-above", threshold: 50 }] });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 100, elapsedMin: 0, phases },
      new Set(["latency"]),
    );
    expect(fired).toEqual([]);
  });

  it("should skip disruptions with no triggers (Phase 1 self-fire only)", () => {
    const fired = evaluateDisruptionTriggers(
      [baseDisruption()],
      { scoreAfter: 9999, elapsedMin: 999, phases },
      new Set(),
    );
    expect(fired).toEqual([]);
  });

  it("should not fire when no trigger condition is met", () => {
    const d = baseDisruption({ triggers: [{ kind: "team-score-above", threshold: 5000 }] });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 100, elapsedMin: 0, phases },
      new Set(),
    );
    expect(fired).toEqual([]);
  });

  it("should default parameters to {} when the disruption declares none", () => {
    const d = baseDisruption({
      parameters: undefined,
      triggers: [{ kind: "after-deploy", afterMinutes: 0 }],
    });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 0, elapsedMin: 1, phases: [] },
      new Set(),
    );
    expect(fired[0]?.parameters).toEqual({});
  });
});

describe("resolveActivePhase (shared, used by phased-polling + triggers)", () => {
  it("should return the last phase whose afterMinutes <= elapsed, defensively sorted", () => {
    const phases: readonly PhaseEntry[] = [
      { name: "degraded", afterMinutes: 20 },
      { name: "normal", afterMinutes: 0 },
    ];
    expect(resolveActivePhase(phases, 5)?.name).toBe("normal");
    expect(resolveActivePhase(phases, 25)?.name).toBe("degraded");
    expect(resolveActivePhase([], 10)).toBeUndefined();
  });
});

describe("parseScoringState firedDisruptions (#1422 idempotency record)", () => {
  it("should round-trip firedDisruptions string[]", () => {
    expect(parseScoringState(JSON.stringify({ firedDisruptions: ["a", "b", 3] }))).toEqual({
      firedDisruptions: ["a", "b"],
    });
  });
  it("should omit firedDisruptions when absent / empty / not an array", () => {
    expect(parseScoringState(JSON.stringify({ attackCount: 1 }))).toEqual({ attackCount: 1 });
    expect(parseScoringState(JSON.stringify({ firedDisruptions: [] }))).toEqual({});
    expect(parseScoringState(JSON.stringify({ firedDisruptions: "x" }))).toEqual({});
  });
});
