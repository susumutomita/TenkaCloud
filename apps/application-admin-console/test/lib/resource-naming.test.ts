import { describe, expect, it } from "vitest";
import {
  buildStackPrefix,
  defaultCompetitorRoleName,
  slugify,
} from "../../src/lib/resource-naming";

describe("slugify", () => {
  it("should replace non-alphanumeric characters with hyphens", () => {
    expect(slugify("Alpha Team")).toBe("alpha-team");
    expect(slugify("Team_42!")).toBe("team-42");
  });

  it("should trim leading and trailing consecutive hyphens", () => {
    expect(slugify("---hello---")).toBe("hello");
    expect(slugify("___under___")).toBe("under");
  });

  it("should lowercase all uppercase characters", () => {
    expect(slugify("ALPHA")).toBe("alpha");
  });

  it("should truncate when longer than 40 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });

  it("should return empty without throwing for empty input", () => {
    expect(slugify("")).toBe("");
  });
});

describe("buildStackPrefix", () => {
  it("should build `tc-{problemSlug}-{teamSlug}`", () => {
    expect(buildStackPrefix("security-battle-royale", "Alpha Team")).toBe(
      "tc-security-battle-royale-alpha-team",
    );
  });

  it("should return different prefixes for different teams on the same problem (collision-avoidance rationale)", () => {
    const a = buildStackPrefix("p", "team-a");
    const b = buildStackPrefix("p", "team-b");
    expect(a).not.toBe(b);
  });

  it("should still produce a prefix when team is empty (validation is the caller's responsibility)", () => {
    expect(buildStackPrefix("p1", "")).toBe("tc-p1-");
  });
});

describe("defaultCompetitorRoleName", () => {
  it("should build TenkaCloud-{tenant}-{namespace}-Role with the default namespace", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme" })).toBe("TenkaCloud-acme-deploy-Role");
    expect(defaultCompetitorRoleName({ tenantId: "acme", namespace: "scoring" })).toBe(
      "TenkaCloud-acme-scoring-Role",
    );
  });

  it("should fall back to 'tenant' / 'deploy' when the segments sanitize to empty", () => {
    // `#` は IAM 許可文字集合外 → sanitize 後が空 → fallback segment に倒す防御分岐。
    expect(defaultCompetitorRoleName({ tenantId: "###", namespace: "###" })).toBe(
      "TenkaCloud-tenant-deploy-Role",
    );
  });

  it("should truncate an over-long tenant id to keep the role name within the 64-char IAM limit", () => {
    const name = defaultCompetitorRoleName({ tenantId: "a".repeat(80) });
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("TenkaCloud-")).toBe(true);
    expect(name.endsWith("-deploy-Role")).toBe(true);
  });
});
