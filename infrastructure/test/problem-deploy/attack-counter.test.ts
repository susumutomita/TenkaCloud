import { describe, expect, it } from "vitest";
import {
  MAX_ATTACK_DELTA_PER_TICK,
  scoreCounterDelta,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/attack-counter";

/**
 * [#1666] CFn-output attack counter の差分加点ロジック (attack-detection と uptime-multi が共有)。
 */

describe("scoreCounterDelta (#1666)", () => {
  it("should record the baseline with 0 points on the first tick (prev undefined)", () => {
    expect(scoreCounterDelta("5", undefined, 25)).toEqual({ points: 0, newCount: 5 });
  });

  it("should award (delta × pointsPer) when the counter increases", () => {
    expect(scoreCounterDelta("5", 2, 25)).toEqual({ points: 75, newCount: 5 }); // 3 × 25
  });

  it("should award 0 and follow the baseline when the counter is unchanged or rewound", () => {
    expect(scoreCounterDelta("5", 5, 25)).toEqual({ points: 0, newCount: 5 });
    expect(scoreCounterDelta("3", 5, 25)).toEqual({ points: 0, newCount: 3 });
  });

  it("should cap the per-tick delta to prevent leaderboard inflation", () => {
    expect(scoreCounterDelta("1000", 0, 25)).toEqual({
      points: MAX_ATTACK_DELTA_PER_TICK * 25,
      newCount: 1000,
    });
  });

  it("should return undefined for absent / empty / non-integer / negative values", () => {
    expect(scoreCounterDelta(undefined, 0, 25)).toBeUndefined();
    expect(scoreCounterDelta("", 0, 25)).toBeUndefined();
    expect(scoreCounterDelta("1.5", 0, 25)).toBeUndefined();
    expect(scoreCounterDelta("-3", 0, 25)).toBeUndefined();
    expect(scoreCounterDelta("abc", 0, 25)).toBeUndefined();
  });

  it("should trim surrounding whitespace before coercion", () => {
    expect(scoreCounterDelta("  7  ", 2, 10)).toEqual({ points: 50, newCount: 7 });
  });
});
