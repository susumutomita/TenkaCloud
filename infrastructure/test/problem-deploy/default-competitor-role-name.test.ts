import { describe, expect, it } from "vitest";
import { defaultCompetitorRoleName } from "../../lib/problem-deploy/handlers/shared/events.js";

/**
 * Issue #1314: 競技者 IAM Role 名は Application Plane (= tenantId) ごとに unique。
 * 同一 AWS account が 別 Plane / 別 event に並列接続できることが本 helper の責務。
 */
describe("defaultCompetitorRoleName", () => {
  const IAM_ROLE_NAME_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
  const TENKACLOUD_ROLE_RE = /^TenkaCloud-[-_A-Za-z0-9]+-Role$/;

  it("should embed tenantId and default namespace into the role name", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme" })).toBe("TenkaCloud-acme-deploy-Role");
  });

  it("should embed a custom namespace when provided", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme", namespace: "q1arena" })).toBe(
      "TenkaCloud-acme-q1arena-Role",
    );
  });

  it("should produce different names for different tenantIds (= no collision when same competitor account joins multiple Planes)", () => {
    const a = defaultCompetitorRoleName({ tenantId: "acme" });
    const b = defaultCompetitorRoleName({ tenantId: "beta" });
    expect(a).not.toBe(b);
  });

  it("should produce the same name for same (tenantId, namespace)", () => {
    expect(defaultCompetitorRoleName({ tenantId: "acme" })).toBe(
      defaultCompetitorRoleName({ tenantId: "acme" }),
    );
  });

  it("should produce different names for different namespaces under the same tenantId", () => {
    const a = defaultCompetitorRoleName({ tenantId: "acme", namespace: "deploy" });
    const b = defaultCompetitorRoleName({ tenantId: "acme", namespace: "rehearsal" });
    expect(a).not.toBe(b);
  });

  it("should always satisfy CFn competitor-bootstrap.yaml AllowedPattern", () => {
    const samples = [
      defaultCompetitorRoleName({ tenantId: "local" }),
      defaultCompetitorRoleName({ tenantId: "tenant-with-dashes" }),
      defaultCompetitorRoleName({ tenantId: "01JABC1234567890" }),
      defaultCompetitorRoleName({ tenantId: "acme", namespace: "q1-arena" }),
    ];
    for (const name of samples) {
      expect(name).toMatch(IAM_ROLE_NAME_RE);
      expect(name).toMatch(TENKACLOUD_ROLE_RE);
    }
  });

  it("should sanitize invalid IAM Role chars (space / slash) into dashes", () => {
    const name = defaultCompetitorRoleName({ tenantId: "tenant/with space" });
    expect(name).toMatch(IAM_ROLE_NAME_RE);
    expect(name).toContain("tenant-with-space");
  });

  it("should trim every leading and trailing dash without changing the role name", () => {
    expect(
      defaultCompetitorRoleName({ tenantId: "---acme---", namespace: "---rehearsal---" }),
    ).toBe("TenkaCloud-acme-rehearsal-Role");
  });

  it("should truncate the tenant segment when the result would exceed 64 chars", () => {
    const longTenant = "a".repeat(200);
    const name = defaultCompetitorRoleName({ tenantId: longTenant });
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("TenkaCloud-")).toBe(true);
    expect(name.endsWith("-deploy-Role")).toBe(true);
  });

  it("should fall back to 'tenant' segment when the tenantId is all invalid chars", () => {
    const name = defaultCompetitorRoleName({ tenantId: "///" });
    expect(name).toBe("TenkaCloud-tenant-deploy-Role");
  });
});
