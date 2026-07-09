import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  createDisruptionsRepository,
  DynamoDbDisruptionsRepository,
  SqlDisruptionsRepository,
} from "../../../lib/problem-deploy/control-data/disruptions-repository";
import { MirroredDisruptionsRepository } from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import type { DisruptionRecurringRecord } from "../../../lib/problem-deploy/control-data/types";
import type { DisruptionAuditRow } from "../../../lib/problem-deploy/handlers/event-handler/disruption-types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C3] DynamoDB byte-pin + SQLite round-trip test suite for the
 * Disruptions seam. Mirrors `competitor-accounts-repository.test.ts`'s structure: byte-pin
 * for the DynamoDB backend (conditional writes included), SQL round-trip, factory /
 * runtime-resolver coverage for all five `CONTROL_DATA_BACKEND` values.
 */

const TABLE = "Disruptions";

function auditRow(over: Partial<DisruptionAuditRow> = {}): DisruptionAuditRow {
  return {
    auditId: "01HZX0AUDIT000000000000001",
    tenantId: "tenant-acme",
    eventId: "01HZX0EVENT000000000000001",
    problemId: "battle-1",
    disruptionId: "router-throttle",
    firedBy: "cognito-sub-1",
    firedAt: "2026-07-08T12:00:00.000Z",
    scope: "all",
    targetTeamIds: ["team-a", "team-b"],
    parameters: { throttleRps: 5 },
    requestId: "req-12345678",
    expiresAt: 1_800_000_000,
    ...over,
  };
}

function recurringRecord(over: Partial<DisruptionRecurringRecord> = {}): DisruptionRecurringRecord {
  return {
    requestId: "req-recur-1",
    tenantId: "tenant-acme",
    eventId: "01HZX0EVENT000000000000001",
    problemId: "battle-1",
    disruptionId: "router-throttle",
    firedBy: "cognito-sub-1",
    firedAt: "2026-07-08T12:00:00.000Z",
    scope: "all",
    affectedTeamIds: ["team-a", "team-b"],
    intervalMinutes: 5,
    maxFires: 3,
    endsAt: "2026-07-08T12:15:00.000Z",
    expiresAt: 1_800_000_000,
    ...over,
  };
}

/** Fake DocumentClient that records the Commands it receives (for byte-pin). */
function recording(): {
  ddb: DynamoDBDocumentClient;
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands.
  commands: any[];
} {
  const ddb = makeFakeDdb();
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands.
  const commands: any[] = [];
  const original = ddb.send.bind(ddb);
  // biome-ignore lint/suspicious/noExplicitAny: wrap the fake send.
  (ddb as any).send = (cmd: any) => {
    commands.push(cmd);
    return original(cmd);
  };
  return { ddb, commands };
}

describe("DynamoDbDisruptionsRepository", () => {
  it("should claim fire idempotency via a conditional Put on the REQUEST# row", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);

    const outcome = await repo.claimFireIdempotency(auditRow());

    expect(outcome).toEqual({ outcome: "claimed" });
    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: {
        PK: "REQUEST#tenant-acme#req-12345678",
        SK: "METADATA",
        GSI1PK: "REQUEST#tenant-acme#req-12345678",
        GSI1SK: "METADATA",
        ...auditRow(),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    });
  });

  it("should return already on a duplicate requestId claim without throwing", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.claimFireIdempotency(auditRow());

    const outcome = await repo.claimFireIdempotency(auditRow());

    expect(outcome).toEqual({ outcome: "already" });
  });

  it("should round-trip the winner's row through getFireIdempotencyRecord (ConsistentRead)", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.claimFireIdempotency(auditRow());
    commands.length = 0;

    const out = await repo.getFireIdempotencyRecord("tenant-acme", "req-12345678");

    expect(out).toEqual(auditRow());
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Key: { PK: "REQUEST#tenant-acme#req-12345678", SK: "METADATA" },
      ConsistentRead: true,
    });
  });

  it("should return undefined from getFireIdempotencyRecord when the row is absent or not yet visible", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    expect(await repo.getFireIdempotencyRecord("tenant-acme", "unknown-req")).toBeUndefined();
  });

  it("should append an audit row via a Put with an SK-uniqueness ConditionExpression", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);

    await repo.appendAudit(auditRow());

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: {
        PK: "EVENT#01HZX0EVENT000000000000001",
        SK: "AUDIT#2026-07-08T12:00:00.000Z#01HZX0AUDIT000000000000001",
        GSI1PK: "TENANT#tenant-acme",
        GSI1SK: "AUDIT#2026-07-08T12:00:00.000Z#01HZX0AUDIT000000000000001",
        ...auditRow(),
      },
      ConditionExpression: "attribute_not_exists(SK)",
    });
  });

  it("should propagate (fail loud) a SK collision on appendAudit instead of swallowing it", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.appendAudit(auditRow());

    await expect(repo.appendAudit(auditRow())).rejects.toThrow(/conditional/i);
  });

  it("should list audit rows newest-first via listAuditPage with a begins_with(SK, AUDIT#) Query", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.appendAudit(auditRow({ auditId: "a1", firedAt: "2026-07-08T12:00:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a2", firedAt: "2026-07-08T12:05:00.000Z" }));
    commands.length = 0;

    const page = await repo.listAuditPage("01HZX0EVENT000000000000001", { limit: 10 });

    expect(page.items.map((i) => i.auditId)).toEqual(["a2", "a1"]);
    expect(page.nextCursor).toBeUndefined();
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :ap)");
    expect(commands[0].input.ScanIndexForward).toBe(false);
    expect(commands[0].input.Limit).toBe(10);
  });

  it("should paginate listAuditPage via an opaque cursor", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.appendAudit(auditRow({ auditId: "a1", firedAt: "2026-07-08T12:00:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a2", firedAt: "2026-07-08T12:05:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a3", firedAt: "2026-07-08T12:10:00.000Z" }));

    const page1 = await repo.listAuditPage("01HZX0EVENT000000000000001", { limit: 1 });
    expect(page1.items.map((i) => i.auditId)).toEqual(["a3"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listAuditPage("01HZX0EVENT000000000000001", {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.auditId)).toEqual(["a2"]);
  });

  it("should list audit rows fired at/after a given ISO timestamp via listAuditSince", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.appendAudit(auditRow({ auditId: "old", firedAt: "2026-07-08T11:00:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "recent", firedAt: "2026-07-08T12:30:00.000Z" }));
    commands.length = 0;

    const rows = await repo.listAuditSince(
      "01HZX0EVENT000000000000001",
      "2026-07-08T12:00:00.000Z",
    );

    expect(rows.map((r) => r.auditId)).toEqual(["recent"]);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk AND SK >= :since");
  });

  it("should put a recurring registry row via a Put with an SK-uniqueness ConditionExpression", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);

    await repo.putRecurringRegistry(recurringRecord());

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: {
        PK: "EVENT#01HZX0EVENT000000000000001",
        SK: "RECUR#req-recur-1",
        GSI1PK: "TENANT#tenant-acme",
        GSI1SK: "RECUR#2026-07-08T12:00:00.000Z#req-recur-1",
        ...recurringRecord(),
      },
      ConditionExpression: "attribute_not_exists(SK)",
    });
  });

  it("should list recurring registry rows for an event, tenant-scoped via FilterExpression", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.putRecurringRegistry(recurringRecord());
    await repo.putRecurringRegistry(
      recurringRecord({ requestId: "req-recur-2", tenantId: "tenant-other" }),
    );
    commands.length = 0;

    const rows = await repo.listRecurringByEvent("01HZX0EVENT000000000000001", "tenant-acme");

    expect(rows.map((r) => r.requestId)).toEqual(["req-recur-1"]);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.FilterExpression).toBe("tenantId = :t");
  });

  it("should round-trip getRecurringRegistry and return undefined when absent", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.putRecurringRegistry(recurringRecord());

    expect(await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1")).toEqual(
      recurringRecord(),
    );
    expect(
      await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "unknown"),
    ).toBeUndefined();
  });

  it("should cancelRecurringRegistry via a tenant-conditioned UpdateCommand", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.putRecurringRegistry(recurringRecord());
    commands.length = 0;

    const outcome = await repo.cancelRecurringRegistry(
      "01HZX0EVENT000000000000001",
      "req-recur-1",
      "tenant-acme",
      "2026-07-08T13:00:00.000Z",
    );

    expect(outcome).toEqual({ outcome: "updated" });
    expect(commands[0]).toBeInstanceOf(UpdateCommand);
    expect(commands[0].input.UpdateExpression).toBe("SET cancelledAt = :c");
    expect(commands[0].input.ConditionExpression).toBe("tenantId = :t");
    const row = await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1");
    expect(row?.cancelledAt).toBe("2026-07-08T13:00:00.000Z");
  });

  it("should return not_found from cancelRecurringRegistry on tenant mismatch or absent row", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.putRecurringRegistry(recurringRecord());

    expect(
      await repo.cancelRecurringRegistry(
        "01HZX0EVENT000000000000001",
        "req-recur-1",
        "tenant-other",
        "2026-07-08T13:00:00.000Z",
      ),
    ).toEqual({ outcome: "not_found" });
    expect(
      await repo.cancelRecurringRegistry(
        "01HZX0EVENT000000000000001",
        "unknown-req",
        "tenant-acme",
        "2026-07-08T13:00:00.000Z",
      ),
    ).toEqual({ outcome: "not_found" });
  });

  it("should claim an EXEC# execution slot per phase (event/inject/recurring)", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    const base = {
      requestId: "req-1",
      teamId: "team-a",
      disruptionId: "router-throttle",
      eventId: "01HZX0EVENT000000000000001",
      problemId: "battle-1",
      tenantId: "tenant-acme",
      firedAt: "2026-07-08T12:00:00.000Z",
      expiresAt: 1_800_000_000,
    };

    const event = await repo.claimExecutionSlot({ ...base, phase: "event" });
    const inject = await repo.claimExecutionSlot({ ...base, phase: "inject" });
    const recurring = await repo.claimExecutionSlot({ ...base, phase: "recurring" });

    expect(event).toEqual({ outcome: "claimed" });
    expect(inject).toEqual({ outcome: "claimed" });
    expect(recurring).toEqual({ outcome: "claimed" });
    // Distinct physical keys per phase — none collide.
    const pks = commands.filter((c) => c instanceof PutCommand).map((c) => c.input.Item.PK);
    expect(pks).toEqual([
      "EXEC#req-1#team-a",
      "EXEC#req-1#team-a#INJECT",
      "EXEC#req-1#team-a#RECUR#2026-07-08T12:00:00.000Z",
    ]);
  });

  it("should return already on a duplicate execution claim without throwing", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    const input = {
      requestId: "req-1",
      teamId: "team-a",
      phase: "event" as const,
      disruptionId: "router-throttle",
      eventId: "01HZX0EVENT000000000000001",
      problemId: "battle-1",
      tenantId: "tenant-acme",
      firedAt: "2026-07-08T12:00:00.000Z",
      expiresAt: 1_800_000_000,
    };
    await repo.claimExecutionSlot(input);

    expect(await repo.claimExecutionSlot(input)).toEqual({ outcome: "already" });
  });

  it("should prune every expired row shape via a filtered Scan", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbDisruptionsRepository(ddb, TABLE);
    await repo.appendAudit(auditRow({ auditId: "expiring", expiresAt: 100 }));
    await repo.appendAudit(
      auditRow({ auditId: "fresh", expiresAt: 9_999_999_999, firedAt: "2026-07-08T12:05:00.000Z" }),
    );
    await repo.putRecurringRegistry(recurringRecord({ expiresAt: 100 }));

    const deleted = await repo.pruneExpired(500);

    expect(deleted).toBe(2);
    const page = await repo.listAuditPage("01HZX0EVENT000000000000001", { limit: 10 });
    expect(page.items.map((i) => i.auditId)).toEqual(["fresh"]);
    expect(
      await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1"),
    ).toBeUndefined();
  });
});

describe("SqlDisruptionsRepository", () => {
  it("should round-trip claim/get through the SQLite backend", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);

    expect(await repo.claimFireIdempotency(auditRow())).toEqual({ outcome: "claimed" });
    expect(await repo.getFireIdempotencyRecord("tenant-acme", "req-12345678")).toEqual(auditRow());
  });

  it("should return already on a duplicate requestId claim without throwing", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.claimFireIdempotency(auditRow());

    expect(await repo.claimFireIdempotency(auditRow())).toEqual({ outcome: "already" });
  });

  it("should append + page + since-query audit rows", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.appendAudit(auditRow({ auditId: "a1", firedAt: "2026-07-08T12:00:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a2", firedAt: "2026-07-08T12:05:00.000Z" }));

    const page = await repo.listAuditPage("01HZX0EVENT000000000000001", { limit: 10 });
    expect(page.items.map((i) => i.auditId)).toEqual(["a2", "a1"]);

    const since = await repo.listAuditSince(
      "01HZX0EVENT000000000000001",
      "2026-07-08T12:03:00.000Z",
    );
    expect(since.map((i) => i.auditId)).toEqual(["a2"]);
  });

  it("should paginate listAuditPage via an opaque cursor", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.appendAudit(auditRow({ auditId: "a1", firedAt: "2026-07-08T12:00:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a2", firedAt: "2026-07-08T12:05:00.000Z" }));
    await repo.appendAudit(auditRow({ auditId: "a3", firedAt: "2026-07-08T12:10:00.000Z" }));

    const page1 = await repo.listAuditPage("01HZX0EVENT000000000000001", { limit: 1 });
    expect(page1.items.map((i) => i.auditId)).toEqual(["a3"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listAuditPage("01HZX0EVENT000000000000001", {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.auditId)).toEqual(["a2"]);
  });

  it("should propagate a sort_key collision on appendAudit (fail loud)", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.appendAudit(auditRow());

    await expect(repo.appendAudit(auditRow())).rejects.toThrow();
  });

  it("should put/list/get/cancel the recurring registry, tenant-scoped", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.putRecurringRegistry(recurringRecord());
    await repo.putRecurringRegistry(
      recurringRecord({ requestId: "req-recur-2", tenantId: "tenant-other" }),
    );

    const rows = await repo.listRecurringByEvent("01HZX0EVENT000000000000001", "tenant-acme");
    expect(rows.map((r) => r.requestId)).toEqual(["req-recur-1"]);

    expect(await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1")).toEqual(
      recurringRecord(),
    );

    expect(
      await repo.cancelRecurringRegistry(
        "01HZX0EVENT000000000000001",
        "req-recur-1",
        "tenant-acme",
        "2026-07-08T13:00:00.000Z",
      ),
    ).toEqual({ outcome: "updated" });
    expect(
      (await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1"))?.cancelledAt,
    ).toBe("2026-07-08T13:00:00.000Z");

    expect(
      await repo.cancelRecurringRegistry(
        "01HZX0EVENT000000000000001",
        "req-recur-1",
        "tenant-other",
        "2026-07-08T13:00:00.000Z",
      ),
    ).toEqual({ outcome: "not_found" });
  });

  it("should claim EXEC# execution slots per phase and report already on redelivery", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    const base = {
      requestId: "req-1",
      teamId: "team-a",
      disruptionId: "router-throttle",
      eventId: "01HZX0EVENT000000000000001",
      problemId: "battle-1",
      tenantId: "tenant-acme",
      firedAt: "2026-07-08T12:00:00.000Z",
      expiresAt: 1_800_000_000,
    };

    expect(await repo.claimExecutionSlot({ ...base, phase: "event" })).toEqual({
      outcome: "claimed",
    });
    expect(await repo.claimExecutionSlot({ ...base, phase: "event" })).toEqual({
      outcome: "already",
    });
    expect(await repo.claimExecutionSlot({ ...base, phase: "inject" })).toEqual({
      outcome: "claimed",
    });
    expect(await repo.claimExecutionSlot({ ...base, phase: "recurring" })).toEqual({
      outcome: "claimed",
    });
  });

  it("should prune every expired row shape across all four tables", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlDisruptionsRepository(sql);
    await repo.appendAudit(auditRow({ auditId: "expiring", expiresAt: 100 }));
    await repo.claimFireIdempotency(auditRow({ requestId: "req-expiring", expiresAt: 100 }));
    await repo.putRecurringRegistry(recurringRecord({ expiresAt: 100 }));
    await repo.claimExecutionSlot({
      requestId: "req-1",
      teamId: "team-a",
      phase: "event",
      disruptionId: "router-throttle",
      eventId: "01HZX0EVENT000000000000001",
      problemId: "battle-1",
      tenantId: "tenant-acme",
      firedAt: "2026-07-08T12:00:00.000Z",
      expiresAt: 100,
    });

    const deleted = await repo.pruneExpired(500);

    expect(deleted).toBe(4);
    expect(await repo.getFireIdempotencyRecord("tenant-acme", "req-expiring")).toBeUndefined();
    expect(
      await repo.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1"),
    ).toBeUndefined();
    expect(
      await repo.claimExecutionSlot({
        requestId: "req-1",
        teamId: "team-a",
        phase: "event",
        disruptionId: "router-throttle",
        eventId: "01HZX0EVENT000000000000001",
        problemId: "battle-1",
        tenantId: "tenant-acme",
        firedAt: "2026-07-08T12:00:00.000Z",
        expiresAt: 9_999_999_999,
      }),
    ).toEqual({ outcome: "claimed" }); // pruned, so re-claimable
  });
});

describe("MirroredDisruptionsRepository", () => {
  it("should apply claimFireIdempotency to the replica only when canonical claims", async () => {
    const canonical = new DynamoDbDisruptionsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlDisruptionsRepository(makeSqliteExecutor());
    const repo = new MirroredDisruptionsRepository(canonical, replica);

    expect(await repo.claimFireIdempotency(auditRow())).toEqual({ outcome: "claimed" });
    await expect(replica.getFireIdempotencyRecord("tenant-acme", "req-12345678")).resolves.toEqual(
      auditRow(),
    );

    // A duplicate claim fails on canonical (DDB) — the replica must not see a second write.
    expect(await repo.claimFireIdempotency(auditRow())).toEqual({ outcome: "already" });
  });

  it("should write-through appendAudit / putRecurringRegistry unconditionally", async () => {
    const canonical = new DynamoDbDisruptionsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlDisruptionsRepository(makeSqliteExecutor());
    const repo = new MirroredDisruptionsRepository(canonical, replica);

    await repo.appendAudit(auditRow());
    await repo.putRecurringRegistry(recurringRecord());

    await expect(
      replica.listAuditPage("01HZX0EVENT000000000000001", { limit: 10 }),
    ).resolves.toMatchObject({ items: [auditRow()] });
    await expect(
      replica.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1"),
    ).resolves.toEqual(recurringRecord());
  });

  it("should apply cancelRecurringRegistry to the replica only when canonical updates", async () => {
    const canonical = new DynamoDbDisruptionsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlDisruptionsRepository(makeSqliteExecutor());
    const repo = new MirroredDisruptionsRepository(canonical, replica);
    await repo.putRecurringRegistry(recurringRecord());

    const outcome = await repo.cancelRecurringRegistry(
      "01HZX0EVENT000000000000001",
      "req-recur-1",
      "tenant-acme",
      "2026-07-08T13:00:00.000Z",
    );

    expect(outcome).toEqual({ outcome: "updated" });
    await expect(
      replica.getRecurringRegistry("01HZX0EVENT000000000000001", "req-recur-1"),
    ).resolves.toMatchObject({ cancelledAt: "2026-07-08T13:00:00.000Z" });

    expect(
      await repo.cancelRecurringRegistry(
        "01HZX0EVENT000000000000001",
        "req-recur-1",
        "tenant-other",
        "2026-07-08T13:00:00.000Z",
      ),
    ).toEqual({ outcome: "not_found" });
  });

  it("should apply claimExecutionSlot to the replica only when canonical claims", async () => {
    const canonical = new DynamoDbDisruptionsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlDisruptionsRepository(makeSqliteExecutor());
    const repo = new MirroredDisruptionsRepository(canonical, replica);
    const input = {
      requestId: "req-1",
      teamId: "team-a",
      phase: "event" as const,
      disruptionId: "router-throttle",
      eventId: "01HZX0EVENT000000000000001",
      problemId: "battle-1",
      tenantId: "tenant-acme",
      firedAt: "2026-07-08T12:00:00.000Z",
      expiresAt: 1_800_000_000,
    };

    expect(await repo.claimExecutionSlot(input)).toEqual({ outcome: "claimed" });
    expect(await repo.claimExecutionSlot(input)).toEqual({ outcome: "already" });
  });

  it("should serve reads from canonical only", async () => {
    const canonicalGet = vi.fn(async () => auditRow({ requestId: "canonical" }));
    const replicaGet = vi.fn(async () => auditRow({ requestId: "replica" }));
    const stub = (get: typeof canonicalGet) => ({
      claimFireIdempotency: async () => ({ outcome: "claimed" as const }),
      getFireIdempotencyRecord: get,
      appendAudit: async () => {},
      listAuditPage: async () => ({ items: [] }),
      listAuditSince: async () => [],
      putRecurringRegistry: async () => {},
      listRecurringByEvent: async () => [],
      getRecurringRegistry: async () => undefined,
      cancelRecurringRegistry: async () => ({ outcome: "not_found" as const }),
      claimExecutionSlot: async () => ({ outcome: "claimed" as const }),
      pruneExpired: async () => 0,
    });
    const repo = new MirroredDisruptionsRepository(stub(canonicalGet), stub(replicaGet));

    const out = await repo.getFireIdempotencyRecord("tenant-acme", "req-12345678");

    expect(out?.requestId).toBe("canonical");
    expect(canonicalGet).toHaveBeenCalledWith("tenant-acme", "req-12345678");
    expect(replicaGet).not.toHaveBeenCalled();
  });

  it("should prune the replica first, then return the canonical count", async () => {
    const canonicalPrune = vi.fn(async () => 3);
    const replicaPrune = vi.fn(async () => 1);
    const order: string[] = [];
    const stub = (prune: () => Promise<number>, label: string) => ({
      claimFireIdempotency: async () => ({ outcome: "claimed" as const }),
      getFireIdempotencyRecord: async () => undefined,
      appendAudit: async () => {},
      listAuditPage: async () => ({ items: [] }),
      listAuditSince: async () => [],
      putRecurringRegistry: async () => {},
      listRecurringByEvent: async () => [],
      getRecurringRegistry: async () => undefined,
      cancelRecurringRegistry: async () => ({ outcome: "not_found" as const }),
      claimExecutionSlot: async () => ({ outcome: "claimed" as const }),
      pruneExpired: async () => {
        order.push(label);
        return prune();
      },
    });
    const repo = new MirroredDisruptionsRepository(
      stub(canonicalPrune, "canonical"),
      stub(replicaPrune, "replica"),
    );

    expect(await repo.pruneExpired(500)).toBe(3);
    expect(order).toEqual(["replica", "canonical"]);
  });
});

describe("createDisruptionsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), disruptionsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createDisruptionsRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbDisruptionsRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createDisruptionsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbDisruptionsRepository,
    );
  });

  it("should select the SQL backend for turso and sql flags", () => {
    expect(createDisruptionsRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlDisruptionsRepository,
    );
    expect(createDisruptionsRepository("sql", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlDisruptionsRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createDisruptionsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createDisruptionsRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createDisruptionsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createDisruptionsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("resolveDisruptionsRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveDisruptionsRepository({
      ddb: makeFakeDdb(),
      disruptionsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbDisruptionsRepository);
  });

  it.each([
    "turso",
    "sql",
  ])("should return the SQL backend for CONTROL_DATA_BACKEND=%s without DDB inputs", async (backend) => {
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: backend,
        TURSO_DATABASE_URL: "file:local.db",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/sql-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } }) },
      createClient: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 }),
        batch: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(runtime.resolveDisruptionsRepository({})).resolves.toBeInstanceOf(
      SqlDisruptionsRepository,
    );
  });

  it.each([
    "turso-mirror",
    "sql-mirror",
  ])("should return the mirrored backend for CONTROL_DATA_BACKEND=%s", async (backend) => {
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: backend,
        TURSO_DATABASE_URL: "file:local.db",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/sql-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } }) },
      createClient: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 }),
        batch: vi.fn().mockResolvedValue([]),
      }),
    });

    const repo = await runtime.resolveDisruptionsRepository({
      ddb: makeFakeDdb(),
      disruptionsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(MirroredDisruptionsRepository);
  });

  it("should fail loudly when mirror/dynamodb backends are missing ddb/disruptionsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "turso-mirror" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveDisruptionsRepository({ ddb: makeFakeDdb() })).rejects.toThrow(
      /mirror backend requires ddb\/disruptionsTableName/,
    );
  });
});
