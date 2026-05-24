import { describe, expect, it } from "vitest";
import { TenantAuditApiError } from "../../src/api/audit-log-client";
import { buildListInput, describeError, mergeItems } from "../../src/pages/AuditLog";

/**
 * Issue #1292: Tenant Admin AuditLog page の pure helpers (= buildListInput / mergeItems /
 * describeError) を pin する。 UI rendering の verify は別 RTL test で。
 */

const aRow = {
  id: "audit-1",
  tenantId: "t-1",
  actor: "u",
  action: "create_event",
  outcome: "success",
  occurredAt: "2026-05-20T10:00:00.000Z",
};
const bRow = { ...aRow, id: "audit-2", action: "delete_event" };

describe("AuditLog page helpers (#1292)", () => {
  it("should build the list input with trimmed filters and cursor", () => {
    expect(
      buildListInput({ from: "  from-x  ", to: " ", principal: "alice", action: "" }, "cur-1"),
    ).toEqual({
      limit: 50,
      cursor: "cur-1",
      from: "from-x",
      principal: "alice",
    });
  });

  it("should append on subsequent pages and replace on first load", () => {
    expect(mergeItems([aRow], [bRow], "cursor-next")).toEqual([aRow, bRow]);
    expect(mergeItems([aRow], [bRow], undefined)).toEqual([bRow]);
  });

  it("should describe TenantAuditApiError, Error, and unknown values", () => {
    expect(describeError(new TenantAuditApiError(403, undefined))).toContain("TenantAdmin");
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(123)).toBe("audit log の取得に失敗しました");
  });
});
