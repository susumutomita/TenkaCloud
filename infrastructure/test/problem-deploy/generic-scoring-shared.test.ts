import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isScoringActive } from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-active";
import { parseScoringState } from "../../lib/problem-deploy/handlers/generic-scoring-handler/scoring-kernel";
import { buildSharedResources } from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * 旧 health-check-handler から `generic-scoring-handler/` に relocate された helper の test。
 * 動作不変 (= health-check-handler.test.ts と同一 assertion)。
 */

describe("buildSharedResources cold start (#2440 / #2442)", () => {
  const REQUIRED_ENV = {
    DEPLOYMENTS_TABLE_NAME: "Deployments",
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  });
  afterEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) delete process.env[k];
    delete process.env.PROBLEM_ENDPOINTS_TABLE_NAME;
  });

  it("should not throw and should default eventsTableName to '' when EVENTS_TABLE_NAME is unset (pure SQL backend cold start)", () => {
    expect(() => buildSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildSharedResources(makeTestControlDataRuntime()).eventsTableName).toBe("");
  });

  it("should still read EVENTS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.EVENTS_TABLE_NAME = "Events";
    expect(buildSharedResources(makeTestControlDataRuntime()).eventsTableName).toBe("Events");
  });

  it("should not throw and should default endpointsTableName to '' when PROBLEM_ENDPOINTS_TABLE_NAME is unset (#2442 pure SQL backend cold start)", () => {
    expect(() => buildSharedResources(makeTestControlDataRuntime())).not.toThrow();
    expect(buildSharedResources(makeTestControlDataRuntime()).endpointsTableName).toBe("");
  });

  it("should still read PROBLEM_ENDPOINTS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "ProblemEndpoints";
    expect(buildSharedResources(makeTestControlDataRuntime()).endpointsTableName).toBe(
      "ProblemEndpoints",
    );
  });
});

describe("isScoringActive (relocated from health-check-handler)", () => {
  const NOW = "2026-05-08T10:00:00.000Z";

  it("should return false when eventStartsAt is unset (prevent unintended scoring right after deploy)", () => {
    expect(isScoringActive({}, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: undefined }, NOW)).toBe(false);
  });

  it("should return false when eventStartsAt is in the future (operator scheduled but time not reached)", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T10:00:00.001Z" }, NOW)).toBe(false);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z" }, NOW)).toBe(false);
  });

  it("should return true when eventStartsAt is at or before now (competition started, scoring active)", () => {
    expect(isScoringActive({ eventStartsAt: NOW }, NOW)).toBe(true);
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
  });

  it("should return true with no end-gate when eventEndsAt is unset and within the liveness cap", () => {
    expect(isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z" }, NOW)).toBe(true);
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(true);
  });

  it("should terminate a no-endsAt round once past the MAX_ROUND_DURATION cap (#1421 liveness)", () => {
    // 開始から 16 ヶ月後 (>> 30 日 cap) は endsAt 未設定でも terminal 扱い → 無限採点を排除。
    expect(isScoringActive({ eventStartsAt: "2025-01-01T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("should return true when eventEndsAt is set and now < eventEndsAt (still competing)", () => {
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T11:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("should return false when eventEndsAt is set and now >= eventEndsAt (operator ended, scoring stopped)", () => {
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T09:00:00.000Z", eventEndsAt: NOW }, NOW),
    ).toBe(false);
    expect(
      isScoringActive(
        {
          eventStartsAt: "2026-05-08T09:00:00.000Z",
          eventEndsAt: "2026-05-08T09:30:00.000Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("should return false when eventStartsAt is not yet reached, even if eventEndsAt is unset (start gate takes precedence)", () => {
    expect(
      isScoringActive({ eventStartsAt: "2026-05-08T11:00:00.000Z", eventEndsAt: undefined }, NOW),
    ).toBe(false);
  });
});

describe("parseScoringState dispatcher state persistence", () => {
  it("should return empty state for undefined / empty string / broken JSON", () => {
    expect(parseScoringState(undefined)).toEqual({});
    expect(parseScoringState("")).toEqual({});
    expect(parseScoringState("{not-json")).toEqual({});
  });

  it("should decode attackCount as a number", () => {
    expect(parseScoringState(JSON.stringify({ attackCount: 42 }))).toEqual({ attackCount: 42 });
  });

  it("should decode bonusAwarded only from boolean=true entries", () => {
    expect(
      parseScoringState(
        JSON.stringify({ bonusAwarded: { "all-slots": true, other: false, x: "no" } }),
      ),
    ).toEqual({ bonusAwarded: { "all-slots": true } });
  });

  it("should decode mixed-field cases", () => {
    expect(
      parseScoringState(JSON.stringify({ attackCount: 1, bonusAwarded: { x: true } })),
    ).toEqual({ attackCount: 1, bonusAwarded: { x: true } });
  });

  it("should return empty state for arrays or primitives", () => {
    expect(parseScoringState(JSON.stringify([1, 2]))).toEqual({});
    expect(parseScoringState(JSON.stringify(123))).toEqual({});
  });

  it("should decode activeEffects and drop malformed entries (#1665)", () => {
    const state = parseScoringState(
      JSON.stringify({
        activeEffects: [
          { disruptionId: "d1", points: 40, expiresAtMs: 1_700_000_060_000 },
          { disruptionId: "", points: 1, expiresAtMs: 1 }, // empty id → dropped
          { disruptionId: "d2", points: "x", expiresAtMs: 1 }, // non-number points → dropped
          { disruptionId: "d3", points: 5 }, // missing expiresAtMs → dropped
          "nope", // non-object → dropped
        ],
      }),
    );
    expect(state.activeEffects).toEqual([
      { disruptionId: "d1", points: 40, expiresAtMs: 1_700_000_060_000 },
    ]);
  });

  it("should omit activeEffects when none survive parsing", () => {
    expect(parseScoringState(JSON.stringify({ activeEffects: [] })).activeEffects).toBeUndefined();
    expect(parseScoringState(JSON.stringify({ activeEffects: "x" })).activeEffects).toBeUndefined();
  });
});
