import { describe, expect, it } from "vitest";
import {
  applyDisruptionEffects,
  buildActiveDisruptionEffect,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/disruption-effects";
import type {
  ActiveDisruptionEffect,
  KindResult,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";

/**
 * [ADR-033 / Issue #1665] scoring-side disruption effect の純ロジックを pin。
 * active な penalty を tick の scoreDelta から引き、 期限切れは prune (= 適用しない)。
 */

const NOW = 1_700_000_000_000;
const baseResult = (scoreDelta: number): KindResult => ({ scoreDelta, scoreEvents: [] });
const effect = (over: Partial<ActiveDisruptionEffect> = {}): ActiveDisruptionEffect => ({
  disruptionId: "d1",
  points: 50,
  expiresAtMs: NOW + 60_000,
  ...over,
});

describe("buildActiveDisruptionEffect (#1665)", () => {
  it("should set expiresAtMs to now + durationSeconds*1000 and carry points", () => {
    const active = buildActiveDisruptionEffect(
      "ceo-5000-users",
      { kind: "penalty", points: 30, durationSeconds: 300 },
      NOW,
    );
    expect(active).toEqual({
      disruptionId: "ceo-5000-users",
      points: 30,
      expiresAtMs: NOW + 300_000,
    });
  });
});

describe("applyDisruptionEffects (#1665)", () => {
  it("should leave the score unchanged when there are no active effects", () => {
    const out = applyDisruptionEffects(baseResult(10), [], NOW);
    expect(out.result.scoreDelta).toBe(10);
    expect(out.surviving).toEqual([]);
  });

  it("should subtract a single active penalty from the tick scoreDelta", () => {
    const out = applyDisruptionEffects(baseResult(10), [effect({ points: 50 })], NOW);
    expect(out.result.scoreDelta).toBe(-40); // 10 - 50
    expect(out.surviving).toHaveLength(1);
  });

  it("should sum multiple active penalties", () => {
    const out = applyDisruptionEffects(
      baseResult(100),
      [effect({ disruptionId: "a", points: 20 }), effect({ disruptionId: "b", points: 30 })],
      NOW,
    );
    expect(out.result.scoreDelta).toBe(50); // 100 - 20 - 30
    expect(out.surviving).toHaveLength(2);
  });

  it("should prune expired effects and not apply them", () => {
    const expired = effect({ disruptionId: "old", expiresAtMs: NOW - 1 });
    const out = applyDisruptionEffects(baseResult(10), [expired], NOW);
    expect(out.result.scoreDelta).toBe(10); // expired → not applied
    expect(out.surviving).toEqual([]);
  });

  it("should apply only the non-expired effects when mixed", () => {
    const out = applyDisruptionEffects(
      baseResult(0),
      [
        effect({ disruptionId: "live", points: 25, expiresAtMs: NOW + 1 }),
        effect({ disruptionId: "dead", points: 99, expiresAtMs: NOW }), // expiresAtMs === now → expired
      ],
      NOW,
    );
    expect(out.result.scoreDelta).toBe(-25); // only the live 25 applies
    expect(out.surviving.map((e) => e.disruptionId)).toEqual(["live"]);
  });

  it("should preserve the rest of the KindResult (scoreEvents / newState)", () => {
    const result: KindResult = {
      scoreDelta: 5,
      scoreEvents: [{ source: "uptime", points: 5, occurredAt: "2026-06-03T00:00:00Z" }],
      newState: { attackCount: 3 },
    };
    const out = applyDisruptionEffects(result, [effect({ points: 5 })], NOW);
    expect(out.result.scoreDelta).toBe(0);
    expect(out.result.scoreEvents).toBe(result.scoreEvents);
    expect(out.result.newState).toEqual({ attackCount: 3 });
  });
});
