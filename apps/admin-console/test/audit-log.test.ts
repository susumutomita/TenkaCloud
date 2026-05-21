import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { AuditApiError } from "../src/api/audit-client";
import {
  buildAuditListInput,
  describeAuditLoadError,
  mergeAuditItems,
  validateAuditLoadInput,
} from "../src/pages/AuditLog";

const t = (key: string) => `t:${key}`;

const firstItem = {
  id: "audit-1",
  tenantId: "tenant-a",
  actor: "admin",
  action: "CreateTenant",
  outcome: "success",
  occurredAt: "2026-05-20T10:00:00.000Z",
};

const secondItem = {
  id: "audit-2",
  tenantId: "tenant-a",
  actor: "admin",
  action: "DeleteTenant",
  outcome: "forbidden",
  occurredAt: "2026-05-20T10:01:00.000Z",
};

describe("AuditLog helpers", () => {
  it("should return a validation error when tenantId is empty under tenant scope", () => {
    expect(validateAuditLoadInput("tenant", "  ", t)).toBe("t:audit_log.tenant_id_required");
    expect(validateAuditLoadInput("system", "  ", t)).toBeNull();
  });

  it("should trim tenantId in the Audit API list input and only include cursor when needed", () => {
    expect(buildAuditListInput("tenant", " tenant-a ", "next")).toEqual({
      scope: "tenant",
      tenantId: "tenant-a",
      limit: 50,
      cursor: "next",
    });
    expect(buildAuditListInput("system", " tenant-a ", undefined)).toEqual({
      scope: "system",
      limit: 50,
    });
  });

  it("should append audit items when a cursor is present and replace them when no cursor", () => {
    expect(mergeAuditItems([firstItem], [secondItem], "next")).toEqual([firstItem, secondItem]);
    expect(mergeAuditItems([firstItem], [secondItem], undefined)).toEqual([secondItem]);
  });

  it("should convert Audit API errors and unknown errors to display text", () => {
    expect(describeAuditLoadError(new AuditApiError(StatusCodes.FORBIDDEN, undefined), t)).toBe(
      "SystemAdmin role が必要です",
    );
    expect(describeAuditLoadError(new Error("network failed"), t)).toBe("network failed");
    expect(describeAuditLoadError("bad", t)).toBe("t:audit_log.fetch_failed");
  });
});
