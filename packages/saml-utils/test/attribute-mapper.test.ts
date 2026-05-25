import { describe, expect, it } from "vitest";
import {
  buildApplicationPlaneUserPk,
  buildControlPlaneUserPk,
  buildIdentityClaim,
  resolveRoles,
} from "../src/attribute-mapper.js";

describe("resolveRoles", () => {
  const idp = {
    groupToRole: {
      "ops-admins": "TenantAdmin",
      observers: "Viewer",
    },
  } as const;

  it("should map known groups to roles and ignore unknown groups", () => {
    expect(resolveRoles(idp, "ops-admins, random-group, observers")).toEqual([
      "TenantAdmin",
      "Viewer",
    ]);
  });

  it("should deduplicate roles when multiple groups map to the same role", () => {
    const dupIdp = {
      groupToRole: { "ops-a": "TenantAdmin", "ops-b": "TenantAdmin" },
    } as const;
    expect(resolveRoles(dupIdp, ["ops-a", "ops-b"])).toEqual(["TenantAdmin"]);
  });

  it("should return an empty array when groups are missing or unmapped (fail closed)", () => {
    expect(resolveRoles(idp, undefined)).toEqual([]);
    expect(resolveRoles(idp, "")).toEqual([]);
    expect(resolveRoles(idp, "unknown-only")).toEqual([]);
  });
});

describe("buildIdentityClaim", () => {
  const idp = {
    groupToRole: { admins: "TenantAdmin" } as const,
  };

  it("should build the canonical claim with subjectId-only keying (never email)", () => {
    const claim = buildIdentityClaim(idp, {
      idpId: "okta-acme",
      subjectId: "00u1tenantsubject",
      email: "alice@acme.example",
      displayName: "Alice",
      groups: ["admins"],
      tenantId: "acme",
    });
    expect(claim).toEqual({
      idpId: "okta-acme",
      subjectId: "00u1tenantsubject",
      tenantId: "acme",
      emailSnapshot: "alice@acme.example",
      displayName: "Alice",
      roles: ["TenantAdmin"],
    });
  });

  it("should throw when subjectId is empty", () => {
    expect(() => buildIdentityClaim(idp, { idpId: "x", subjectId: "" })).toThrow();
  });

  it("should throw when idpId is empty", () => {
    expect(() => buildIdentityClaim(idp, { idpId: "", subjectId: "s" })).toThrow();
  });
});

describe("user PK builders", () => {
  it("should build a Control Plane PK from (idpId, subjectId)", () => {
    expect(buildControlPlaneUserPk("okta-corp", "00u1abc")).toBe("okta-corp#00u1abc");
  });

  it("should build an Application Plane PK from (tenantId, idpId, subjectId)", () => {
    expect(buildApplicationPlaneUserPk("acme", "okta-acme", "00u1def")).toBe(
      "acme#okta-acme#00u1def",
    );
  });

  it("should never collide across IdPs even when subjectId+email look identical", () => {
    // Same email "alice@acme.example" backed by two different IdPs ⇒ two PKs.
    const pkOkta = buildControlPlaneUserPk("okta-acme", "shared-subject-id");
    const pkAzure = buildControlPlaneUserPk("azure-acme", "shared-subject-id");
    expect(pkOkta).not.toBe(pkAzure);
  });
});
