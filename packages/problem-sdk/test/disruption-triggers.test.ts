import { describe, expect, it } from "vitest";
import { evaluateDisruptionTriggers, triggerMatches } from "../src/disruption-triggers.js";
import type {
  DisruptionTrigger,
  ProblemDisruptionEntry,
  ProblemPhaseEntry,
} from "../src/metadata-parser.js";

const baseDisruption = (over: Partial<ProblemDisruptionEntry> = {}): ProblemDisruptionEntry => ({
  id: "latency",
  name: "EC2 latency",
  eventDetailType: "DegradedDisruptionFired",
  parameters: { delayMs: 200 },
  ...over,
});

describe("triggerMatches", () => {
  const ctx = { scoreAfter: 100, elapsedMin: 30, phases: [] as readonly ProblemPhaseEntry[] };
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
  const phases: readonly ProblemPhaseEntry[] = [
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

  it("should carry recurrence into the fired result for a score-gated repeat", () => {
    const d = baseDisruption({
      triggers: [{ kind: "team-score-above", threshold: 50 }],
      recurrence: { intervalMinutes: 5, maxFires: 6 },
    });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 100, elapsedMin: 5, phases },
      new Set(),
    );
    expect(fired[0]?.recurrence).toEqual({ intervalMinutes: 5, maxFires: 6 });
  });

  it("should omit recurrence for a one-shot triggered disruption", () => {
    const d = baseDisruption({ triggers: [{ kind: "team-score-above", threshold: 50 }] });
    const fired = evaluateDisruptionTriggers(
      [d],
      { scoreAfter: 100, elapsedMin: 5, phases },
      new Set(),
    );
    expect(fired[0]).not.toHaveProperty("recurrence");
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
