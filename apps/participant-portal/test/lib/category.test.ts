import { describe, expect, it } from "vitest";
import type { ParticipantScoringInfo } from "../../src/api/portal-client";
import { categoryOf } from "../../src/lib/category";

describe("categoryOf", () => {
  it("should return null when scoring is undefined (= uncategorized)", () => {
    expect(categoryOf(undefined)).toBeNull();
  });

  it("should return battle for kind=uptime", () => {
    const scoring: ParticipantScoringInfo = { kind: "uptime", pointsPerSuccess: 5 };
    expect(categoryOf(scoring)).toBe("battle");
  });

  it("should return challenge for kind=flag", () => {
    const scoring: ParticipantScoringInfo = { kind: "flag", points: 100 };
    expect(categoryOf(scoring)).toBe("challenge");
  });

  it("should return challenge for kind=multi-flag (Issue #1796 — submission axis)", () => {
    const scoring: ParticipantScoringInfo = { kind: "multi-flag", points: 500, flags: [] };
    expect(categoryOf(scoring)).toBe("challenge");
  });

  it("should return battle for kind=phased-polling (#688 regression — phased-polling is on the battle axis)", () => {
    const scoring: ParticipantScoringInfo = { kind: "phased-polling" };
    expect(categoryOf(scoring)).toBe("battle");
  });

  it("should return battle for both kind=uptime-flat and uptime-multi", () => {
    expect(categoryOf({ kind: "uptime-flat" })).toBe("battle");
    expect(categoryOf({ kind: "uptime-multi" })).toBe("battle");
  });

  it("should return battle for kind=attack-detection", () => {
    expect(categoryOf({ kind: "attack-detection" })).toBe("battle");
  });
});
