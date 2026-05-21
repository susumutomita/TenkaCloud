import { describe, expect, it } from "vitest";
import { buildStackPrefix, slugify } from "../../lib/problem-deploy/handlers/deploy-handler/naming";

describe("backend naming (frontend と同じ規約)", () => {
  it("buildStackPrefix should return `tc-{problemSlug}-{teamSlug}`", () => {
    expect(buildStackPrefix("security-battle-royale", "Alpha Team")).toBe(
      "tc-security-battle-royale-alpha-team",
    );
  });

  it("slugify should convert non-alphanumerics to hyphens", () => {
    expect(slugify("Alpha Team!")).toBe("alpha-team");
  });

  it("should trim leading/trailing consecutive hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("should truncate when exceeding 40 characters", () => {
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });

  it("should return empty for empty input (validation is the caller's responsibility)", () => {
    expect(slugify("")).toBe("");
  });
});
