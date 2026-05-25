import { describe, expect, it } from "vitest";
import { defaultCompetitorRoleName } from "./resource-naming";

/**
 * Issue #1314: SPA 側 generator が `events.ts` (backend) と同じロジックで Plane scope の
 * unique 名を提案できることを assert する。
 */
describe("defaultCompetitorRoleName (SPA)", () => {
  const IAM_ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
  const TENKACLOUD_ROLE_RE = /^TenkaCloud-[-_A-Za-z0-9]+-Role$/;

  it("should embed tenantId with default namespace", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme" })).toBe("TenkaCloud-acme-deploy-Role");
  });

  it("should produce different names for different tenantIds", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme" })).not.toBe(
      defaultCompetitorRoleName({ tenantId: "beta" }),
    );
  });

  it("should produce different names for different namespaces", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme", namespace: "deploy" })).not.toBe(
      defaultCompetitorRoleName({ tenantId: "acme", namespace: "rehearsal" }),
    );
  });

  it("should satisfy CFn AllowedPattern + TenkaCloud-{...}-Role shape", () => {
    const name = defaultCompetitorRoleName({ tenantId: "acme" });
    expect(name).toMatch(IAM_ROLE_NAME_RE);
    expect(name).toMatch(TENKACLOUD_ROLE_RE);
  });

  it("should cap output at 64 chars", () => {
    const name = defaultCompetitorRoleName({ tenantId: "a".repeat(200) });
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
