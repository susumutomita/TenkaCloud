import { describe, expect, it } from "vitest";
import {
  LOCAL_DRILL_FIRST_SCORE,
  LOCAL_DRILL_PROBLEM_ID,
  matchesCheckpointCode,
  matchesLocalDrillFirstScore,
} from "../src/index.js";

describe("local-drill checkpoint (#2707)", () => {
  it("should expose the drill problem id and a TENKA{...}-shaped checkpoint code", () => {
    expect(LOCAL_DRILL_PROBLEM_ID).toBe("play-local-mode");
    expect(LOCAL_DRILL_FIRST_SCORE.flagId).toBe("first-score");
    expect(LOCAL_DRILL_FIRST_SCORE.code).toMatch(/^TENKA\{[A-Z0-9-]+\}$/);
  });

  it("should match the first-score code ignoring whitespace and letter case", () => {
    expect(matchesLocalDrillFirstScore("  tenka{local-first-score} ")).toBe(true);
    expect(matchesLocalDrillFirstScore(LOCAL_DRILL_FIRST_SCORE.code)).toBe(true);
    expect(matchesLocalDrillFirstScore("TENKA{WRONG}")).toBe(false);
  });

  it("should share one checkpoint matcher with the lite drill", () => {
    expect(matchesCheckpointCode("TENKA{X}", " tenka{x} ")).toBe(true);
    expect(matchesCheckpointCode("TENKA{X}", "tenka{y}")).toBe(false);
  });
});
