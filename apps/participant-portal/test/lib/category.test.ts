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
});
