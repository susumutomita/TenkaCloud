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
  it("tenant scope で tenantId が空なら validation error を返すべき", () => {
    expect(validateAuditLoadInput("tenant", "  ", t)).toBe("t:audit_log.tenant_id_required");
    expect(validateAuditLoadInput("system", "  ", t)).toBeNull();
  });

  it("Audit API list input は tenantId を trim し cursor を必要時だけ含めるべき", () => {
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

  it("cursor ありなら audit items を append し cursor 無しなら差し替えるべき", () => {
    expect(mergeAuditItems([firstItem], [secondItem], "next")).toEqual([firstItem, secondItem]);
    expect(mergeAuditItems([firstItem], [secondItem], undefined)).toEqual([secondItem]);
  });

  it("Audit API error と unknown error を表示文言に変換すべき", () => {
    expect(describeAuditLoadError(new AuditApiError(StatusCodes.FORBIDDEN, undefined), t)).toBe(
      "SystemAdmin role が必要です",
    );
    expect(describeAuditLoadError(new Error("network failed"), t)).toBe("network failed");
    expect(describeAuditLoadError("bad", t)).toBe("t:audit_log.fetch_failed");
  });
});
