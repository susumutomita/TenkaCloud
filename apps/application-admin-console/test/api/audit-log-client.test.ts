import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import {
  buildTenantAuditQuery,
  describeTenantAuditError,
  TenantAuditApiError,
} from "../../src/api/audit-log-client";

/**
 * Issue #1292: tenant audit client の query 構築と error 変換を pin する。
 * fetch 自体は Vitest 環境の global fetch mock で別途観測する想定 (本 test は string 構築)。
 */

describe("buildTenantAuditQuery (#1292)", () => {
  it("should return empty string when no filters", () => {
    expect(buildTenantAuditQuery({})).toBe("");
  });

  it("should include all provided filters as URLSearchParams", () => {
    const qs = buildTenantAuditQuery({
      limit: 50,
      cursor: "abc",
      from: "2026-05-20T00:00:00.000Z",
      to: "2026-05-21T00:00:00.000Z",
      principal: "alice@example.com",
      action: "create_event",
    });
    expect(qs.startsWith("?")).toBe(true);
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get("limit")).toBe("50");
    expect(params.get("cursor")).toBe("abc");
    expect(params.get("from")).toBe("2026-05-20T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-05-21T00:00:00.000Z");
    expect(params.get("principal")).toBe("alice@example.com");
    expect(params.get("action")).toBe("create_event");
  });
});

describe("describeTenantAuditError (#1292)", () => {
  it("should map status codes to operator-friendly messages", () => {
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.FORBIDDEN, undefined)),
    ).toBe("TenantAdmin role が必要です");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.SERVICE_UNAVAILABLE, undefined)),
    ).toContain("audit log table");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.BAD_REQUEST, "invalid_from")),
    ).toBe("from が無効な timestamp です");
    expect(
      describeTenantAuditError(new TenantAuditApiError(StatusCodes.UNAUTHORIZED, undefined)),
    ).toContain("セッション");
  });
});
