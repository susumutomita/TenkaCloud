import { describe, expect, it } from "vitest";
import type { ParticipantScoringInfo } from "../../src/api/portal-client";
import { categoryOf } from "../../src/lib/category";

describe("categoryOf", () => {
  it("scoring が undefined なら null を返すべき (= 未分類)", () => {
    expect(categoryOf(undefined)).toBeNull();
  });

  it("kind=uptime は battle を返すべき", () => {
    const scoring: ParticipantScoringInfo = { kind: "uptime", pointsPerSuccess: 5 };
    expect(categoryOf(scoring)).toBe("battle");
  });

  it("kind=flag は challenge を返すべき", () => {
    const scoring: ParticipantScoringInfo = { kind: "flag", points: 100 };
    expect(categoryOf(scoring)).toBe("challenge");
  });

  it("kind=phased-polling は battle を返すべき (#688 regression — phased-polling は battle 軸)", () => {
    const scoring: ParticipantScoringInfo = { kind: "phased-polling" };
    expect(categoryOf(scoring)).toBe("battle");
  });

  it("kind=uptime-flat / uptime-multi はいずれも battle を返すべき", () => {
    expect(categoryOf({ kind: "uptime-flat" })).toBe("battle");
    expect(categoryOf({ kind: "uptime-multi" })).toBe("battle");
  });

  it("kind=attack-detection は battle を返すべき", () => {
    expect(categoryOf({ kind: "attack-detection" })).toBe("battle");
  });
});
