import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportAuditEntriesCsv,
  listAuditEntries,
} from "../../lib/admin-insight/handlers/admin-insight-handler/audit";
import { DynamoDbAdminAuditLogRepository } from "../../lib/problem-deploy/control-data/admin-audit-log-repository";

/**
 * Issue #1292: listAuditEntries の filter 拡張 (from/to/action/principal) と
 * exportAuditEntriesCsv の CSV 形式を pin する。
 *
 * [Issue #2442 / Phase C4] `listAuditEntries` / `exportAuditEntriesCsv` now take a
 * `{ repository }` dep. Tests wrap the same fake `send` mock in a real
 * `DynamoDbAdminAuditLogRepository` so the assertions stay behavior-identical.
 */

afterEach(() => vi.clearAllMocks());

describe("listAuditEntries filter (#1292)", () => {
  it("should drop rows outside the from / to range", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#A",
          actor: "u",
          action: "a",
          outcome: "success",
          occurredAt: "2026-05-20T12:00:00.000Z",
        },
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#B",
          actor: "u",
          action: "b",
          outcome: "success",
          occurredAt: "2026-05-21T12:00:00.000Z",
        },
      ],
    });
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const out = await listAuditEntries(
      { repository },
      {
        scope: "tenant",
        tenantId: "t-1",
        from: "2026-05-21T00:00:00.000Z",
        to: "2026-05-21T23:59:59.999Z",
      },
      "test",
    );
    expect(out.items.map((i) => i.action)).toEqual(["b"]);
  });

  it("should match principal against actor or actorUsername", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#A",
          actor: "sub-1",
          actorUsername: "alice@example.com",
          action: "x",
          outcome: "success",
          occurredAt: "t1",
        },
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#B",
          actor: "sub-2",
          action: "y",
          outcome: "success",
          occurredAt: "t2",
        },
      ],
    });
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const byUsername = await listAuditEntries(
      { repository },
      { scope: "tenant", tenantId: "t-1", principal: "alice@example.com" },
      "test",
    );
    expect(byUsername.items.map((i) => i.actor)).toEqual(["sub-1"]);
  });
});

describe("exportAuditEntriesCsv (#1292)", () => {
  it("should emit a header row + escaped data row", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          PK: "SYSTEM#prod",
          SK: "AUDIT#A",
          actor: "sys",
          action: "rotate_external_id",
          outcome: "success",
          target: 'a,b"c',
          occurredAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const csv = await exportAuditEntriesCsv({ repository }, { scope: "system" }, "prod");
    const lines = csv.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe(
      "occurredAt,tenantId,actor,actorUsername,action,outcome,target,ipAddress,userAgent",
    );
    expect(lines[1]).toContain('"a,b""c"');
  });
});
