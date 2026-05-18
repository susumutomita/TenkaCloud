import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEntries } from "../../lib/admin-insight/handlers/admin-insight-handler/audit";

/**
 * Issue #950 (ADR-020 Phase D): listAuditEntries の挙動を pin する。
 *
 * - scope=tenant + tenantId → PK=TENANT#<id> で Query
 * - scope=system → PK=SYSTEM#<env> で Query
 * - ScanIndexForward=false (= 新しい順)
 * - cursor + nextCursor を base64(LastEvaluatedKey) で round-trip
 */

beforeEach(() => {
  // noop — handlers are pure functions on ddb mock
});
afterEach(() => {
  vi.clearAllMocks();
});

function buildMock() {
  const send = vi.fn();
  return { ddb: { send }, send };
}

describe("listAuditEntries (#950)", () => {
  it("scope=tenant は PK=TENANT#<id> で Query するべき", async () => {
    const { ddb, send } = buildMock();
    send.mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#01HX",
          actor: "u-1",
          action: "patch_user_role",
          outcome: "success",
          occurredAt: "2026-05-17T12:00:00.000Z",
        },
      ],
      LastEvaluatedKey: undefined,
    });
    const out = await listAuditEntries(
      { ddb: ddb as never, auditTableName: "T" },
      { scope: "tenant", tenantId: "t-1", limit: 10 },
      "test-env",
    );
    expect(out.items.length).toBe(1);
    expect(out.items[0]?.tenantId).toBe("t-1");
    expect(out.items[0]?.action).toBe("patch_user_role");
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.KeyConditionExpression).toBe("PK = :pk");
    expect((cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "TENANT#t-1",
    );
    expect(cmd.input?.Limit).toBe(10);
    expect(cmd.input?.ScanIndexForward).toBe(false);
  });

  it("scope=system は PK=SYSTEM#<env> で Query するべき", async () => {
    const { ddb, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await listAuditEntries({ ddb: ddb as never, auditTableName: "T" }, { scope: "system" }, "prod");
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect((cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "SYSTEM#prod",
    );
  });

  it("LastEvaluatedKey から nextCursor を base64 で返すべき", async () => {
    const { ddb, send } = buildMock();
    const lastKey = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });
    const out = await listAuditEntries(
      { ddb: ddb as never, auditTableName: "T" },
      { scope: "tenant", tenantId: "t-1" },
      "test-env",
    );
    expect(out.nextCursor).toBe(Buffer.from(JSON.stringify(lastKey)).toString("base64"));
  });

  it("cursor を decode して ExclusiveStartKey に渡すべき", async () => {
    const { ddb, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const key = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    const cursor = Buffer.from(JSON.stringify(key)).toString("base64");
    await listAuditEntries(
      { ddb: ddb as never, auditTableName: "T" },
      { scope: "tenant", tenantId: "t-1", cursor },
      "test-env",
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.ExclusiveStartKey).toEqual(key);
  });

  it("limit > 200 は 200 に clamp するべき", async () => {
    const { ddb, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await listAuditEntries(
      { ddb: ddb as never, auditTableName: "T" },
      { scope: "tenant", tenantId: "t-1", limit: 9999 },
      "test-env",
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.Limit).toBe(200);
  });

  it("optional attrs (target / ipAddress / userAgent / extra) を含む item を正しく map するべき", async () => {
    const { ddb, send } = buildMock();
    send.mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#01HX",
          actor: "u-1",
          actorUsername: "alice@example.com",
          action: "invite_user",
          outcome: "success",
          target: "bob@example.com",
          ipAddress: "203.0.113.5",
          userAgent: "Mozilla/5.0",
          occurredAt: "2026-05-17T12:00:00.000Z",
          extra: { userRole: "TenantViewer" },
        },
      ],
    });
    const out = await listAuditEntries(
      { ddb: ddb as never, auditTableName: "T" },
      { scope: "tenant", tenantId: "t-1" },
      "test-env",
    );
    expect(out.items[0]?.actorUsername).toBe("alice@example.com");
    expect(out.items[0]?.target).toBe("bob@example.com");
    expect(out.items[0]?.ipAddress).toBe("203.0.113.5");
    expect(out.items[0]?.userAgent).toBe("Mozilla/5.0");
    expect(out.items[0]?.extra).toEqual({ userRole: "TenantViewer" });
  });
});
