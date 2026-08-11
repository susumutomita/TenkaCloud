import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEntries } from "../../lib/admin-insight/handlers/admin-insight-handler/audit";
import { DynamoDbAdminAuditLogRepository } from "../../lib/problem-deploy/control-data/admin-audit-log-repository";

/**
 * Issue #950: listAuditEntries の挙動を pin する。
 *
 * - scope=tenant + tenantId → PK=TENANT#<id> で Query
 * - scope=system → PK=SYSTEM#<env> で Query
 * - ScanIndexForward=false (= 新しい順)
 * - cursor + nextCursor を base64(LastEvaluatedKey) で round-trip
 *
 * [Issue #2442 / Phase C4] `listAuditEntries` now takes a `{ repository }` dep. Tests wrap the
 * same fake `send` mock in a real `DynamoDbAdminAuditLogRepository` so the DDB command
 * assertions below stay byte-identical.
 */

beforeEach(() => {
  // noop — handlers are pure functions on ddb mock
});
afterEach(() => {
  vi.clearAllMocks();
});

function buildMock() {
  const send = vi.fn();
  const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
  return { repository, send };
}

describe("listAuditEntries (#950)", () => {
  it("scope=tenant should Query with PK=TENANT#<id>", async () => {
    const { repository, send } = buildMock();
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
      { repository },
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

  it("scope=system should Query with PK=SYSTEM#<env>", async () => {
    const { repository, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await listAuditEntries({ repository }, { scope: "system" }, "prod");
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect((cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "SYSTEM#prod",
    );
  });

  it("should return nextCursor as base64 from LastEvaluatedKey", async () => {
    const { repository, send } = buildMock();
    const lastKey = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey });
    const out = await listAuditEntries(
      { repository },
      { scope: "tenant", tenantId: "t-1" },
      "test-env",
    );
    expect(out.nextCursor).toBe(Buffer.from(JSON.stringify(lastKey)).toString("base64"));
  });

  it("should decode the cursor and pass it as ExclusiveStartKey", async () => {
    const { repository, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const key = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    const cursor = Buffer.from(JSON.stringify(key)).toString("base64");
    await listAuditEntries(
      { repository },
      { scope: "tenant", tenantId: "t-1", cursor },
      "test-env",
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.ExclusiveStartKey).toEqual(key);
  });

  it("should clamp limit > 200 to 200", async () => {
    const { repository, send } = buildMock();
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    await listAuditEntries(
      { repository },
      { scope: "tenant", tenantId: "t-1", limit: 9999 },
      "test-env",
    );
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.Limit).toBe(200);
  });

  it("should correctly map items containing optional attrs (target / ipAddress / userAgent / extra)", async () => {
    const { repository, send } = buildMock();
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
      { repository },
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
