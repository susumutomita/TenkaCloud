import { describe, expect, it } from "vitest";
import {
  flagMatches,
  runFlagKind,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/flag";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { FlagScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `flag` kind は polling 経由では **no-op**。 採点は POST `/submit-flag` 経路で
 * event-triggered に走る (= submit-flag.ts)。 本 test は dispatcher が flag kind を
 * skip すること、 `flagMatches` 共通 helper が submit-flag.ts と同 logic を共有する
 * ことを pin する。
 */

describe("flag kind in polling dispatcher", () => {
  it("should do nothing via polling (scoreDelta=0, empty scoreEvents)", () => {
    const input: KindHandlerInput<FlagScoringMetadata> = {
      deployment: { PK: "DEPLOYMENT#JOB1", jobId: "JOB1", problemId: "hello-world" },
      scoring: { kind: "flag", flagOutputKey: "ParameterValue", points: 100 },
      slots: [],
      overrides: [],
      phases: [] as readonly PhaseEntry[],
      nowMs: 0,
      nowIso: "2026-05-12T10:00:00.000Z",
      prevState: {},
    };
    const result = runFlagKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
  });
});

describe("flagMatches (shared helper、 submit-flag と共有)", () => {
  it("should return true on match", () => {
    expect(flagMatches("hello", "hello")).toBe(true);
  });

  it("should compare equality after trimming both ends", () => {
    expect(flagMatches("  hello  ", "hello")).toBe(true);
    expect(flagMatches("hello\n", "hello")).toBe(true);
  });

  it("should be case-sensitive", () => {
    expect(flagMatches("Hello", "hello")).toBe(false);
  });

  it("should distinguish spaces in the middle", () => {
    expect(flagMatches("hello world", "hello  world")).toBe(false);
  });

  it("should match a realistic per-deploy TC{...} flag exactly", () => {
    const flag = "TC{a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6}";
    expect(flagMatches(flag, flag)).toBe(true);
    expect(flagMatches(`  ${flag}\n`, flag)).toBe(true);
  });

  it("should reject a near-miss that differs only in the last character (constant-time)", () => {
    expect(
      flagMatches("TC{a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6}", "TC{a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P7}"),
    ).toBe(false);
  });

  it("should not treat empty input as a match for a non-empty flag", () => {
    expect(flagMatches("", "TC{secret}")).toBe(false);
    expect(flagMatches("   ", "TC{secret}")).toBe(false);
  });
});
