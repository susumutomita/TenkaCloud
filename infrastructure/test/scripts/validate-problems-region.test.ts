import { describe, expect, it } from "vitest";
import { checkRegionConsistency } from "../../../scripts/validate-problems";

/**
 * Issue #1201 Phase 2: `checkRegionConsistency` の動作を pin する unit test。
 *
 * Validator は `defaultRegion` / `supportedRegions` が宣言された場合のみ動き、
 * 未宣言なら no-op (= 後方互換) であることを保証する。
 */

describe("checkRegionConsistency", () => {
  it("should be a no-op when neither defaultRegion nor supportedRegions is declared", () => {
    expect(checkRegionConsistency({})).toEqual([]);
  });

  it("should accept defaultRegion alone with a valid AWS region format", () => {
    expect(checkRegionConsistency({ defaultRegion: "ap-northeast-1" })).toEqual([]);
  });

  it("should reject defaultRegion with a non-AWS-region string", () => {
    const errors = checkRegionConsistency({ defaultRegion: "not-a-region" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("defaultRegion");
    expect(errors[0]).toContain("not-a-region");
  });

  it("should accept supportedRegions alone with valid region codes", () => {
    expect(checkRegionConsistency({ supportedRegions: ["us-east-1", "us-west-2"] })).toEqual([]);
  });

  it("should reject an empty supportedRegions array (= declared but useless)", () => {
    const errors = checkRegionConsistency({ supportedRegions: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("supportedRegions");
  });

  it("should reject supportedRegions with non-region values", () => {
    const errors = checkRegionConsistency({ supportedRegions: ["us-east-1", "not-a-region"] });
    expect(errors.some((e) => e.includes("not-a-region"))).toBe(true);
  });

  it("should reject when defaultRegion is not in declared supportedRegions", () => {
    const errors = checkRegionConsistency({
      defaultRegion: "ap-northeast-1",
      supportedRegions: ["us-east-1", "us-west-2"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ap-northeast-1");
    expect(errors[0]).toContain("supportedRegions");
  });

  it("should accept when defaultRegion is in declared supportedRegions", () => {
    expect(
      checkRegionConsistency({
        defaultRegion: "us-east-1",
        supportedRegions: ["us-east-1", "us-west-2"],
      }),
    ).toEqual([]);
  });
});
