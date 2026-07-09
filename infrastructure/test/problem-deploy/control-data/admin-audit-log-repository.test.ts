import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  createAdminAuditLogRepository,
  DynamoDbAdminAuditLogRepository,
  SqlAdminAuditLogRepository,
} from "../../../lib/problem-deploy/control-data/admin-audit-log-repository";
import { MirroredAdminAuditLogRepository } from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import type { AdminAuditRow } from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C4] DynamoDB / SQL / Mirrored byte-pin + parity test suite for the
 * AdminAuditLog seam. Mirrors `disruptions-repository.test.ts` / `problem-endpoints-repository
 * .test.ts`'s structure: round-trip + byte-pin for the DynamoDB backend, round-trip for the SQL
 * backend, write-through/read-passthrough for Mirrored, plus factory / runtime-resolver coverage
 * for all five `CONTROL_DATA_BACKEND` values.
 */

const TABLE = "AdminAuditLog";

function row(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    pk: "TENANT#tenant-a",
    sk: "AUDIT#01HZX0AUDIT00000000000001",
    gsi1pk: "ACTOR#sub-1",
    gsi1sk: "2026-07-08T12:00:00.000Z",
    actor: "sub-1",
    action: "patch_user_role",
    outcome: "success",
    occurredAt: "2026-07-08T12:00:00.000Z",
    ttl: 1_800_000_000,
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

describe("DynamoDbAdminAuditLogRepository", () => {
  it("should Put an audit row with no ConditionExpression (verbatim relocation)", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);

    await repo.appendAudit(row());

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: {
        PK: "TENANT#tenant-a",
        SK: "AUDIT#01HZX0AUDIT00000000000001",
        GSI1PK: "ACTOR#sub-1",
        GSI1SK: "2026-07-08T12:00:00.000Z",
        actor: "sub-1",
        action: "patch_user_role",
        outcome: "success",
        occurredAt: "2026-07-08T12:00:00.000Z",
        ttl: 1_800_000_000,
      },
    });
    expect(commands[0].input.ConditionExpression).toBeUndefined();
  });

  it("should include optional fields (actorUsername / target / ipAddress / userAgent / extra) when present", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);

    await repo.appendAudit(
      row({
        actorUsername: "alice@example.com",
        target: "bob@example.com",
        ipAddress: "203.0.113.5",
        userAgent: "Mozilla/5.0",
        extra: { reason: "downgrade" },
      }),
    );

    expect(commands[0].input.Item).toMatchObject({
      actorUsername: "alice@example.com",
      target: "bob@example.com",
      ipAddress: "203.0.113.5",
      userAgent: "Mozilla/5.0",
      extra: { reason: "downgrade" },
    });
  });

  it("should round-trip an appended row through listPage, newest-first", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));

    const page = await repo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(page.items.map((r) => r.sk)).toEqual(["AUDIT#B", "AUDIT#A"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("should Query with PK equality only (no SK condition) and ScanIndexForward=false", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);

    await repo.listPage("TENANT#tenant-a", { limit: 5 });

    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk");
    expect(commands[0].input.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#tenant-a" });
    expect(commands[0].input.Limit).toBe(5);
    expect(commands[0].input.ScanIndexForward).toBe(false);
  });

  it("should page with a plain base64 cursor (byte-compatible with the pre-seam handler)", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));

    const page1 = await repo.listPage("TENANT#tenant-a", { limit: 1 });
    expect(page1.items.map((r) => r.sk)).toEqual(["AUDIT#B"]);
    expect(page1.nextCursor).toBeDefined();
    // Plain base64 JSON of the LastEvaluatedKey, not base64url / allowlist-validated.
    const decoded = JSON.parse(Buffer.from(page1.nextCursor as string, "base64").toString("utf-8"));
    expect(decoded).toEqual({ PK: "TENANT#tenant-a", SK: "AUDIT#B" });

    const page2 = await repo.listPage("TENANT#tenant-a", { limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.sk)).toEqual(["AUDIT#A"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("should ignore a malformed cursor and query from the start", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row());

    const page = await repo.listPage("TENANT#tenant-a", {
      limit: 10,
      cursor: Buffer.from("not json", "utf-8").toString("base64"),
    });

    expect(page.items.length).toBe(1);
  });

  it("should drain every page in listAllByPartition, bounded by maxPages", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));
    await repo.appendAudit(row({ sk: "AUDIT#C" }));

    const rows = await repo.listAllByPartition("TENANT#tenant-a", { pageSize: 1, maxPages: 10 });

    expect(rows.map((r) => r.sk)).toEqual(["AUDIT#C", "AUDIT#B", "AUDIT#A"]);
  });

  it("should stop draining at maxPages even when more rows remain", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));
    await repo.appendAudit(row({ sk: "AUDIT#C" }));

    const rows = await repo.listAllByPartition("TENANT#tenant-a", { pageSize: 1, maxPages: 2 });

    expect(rows.length).toBe(2);
  });

  it("should return [] when no rows exist for the partition", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    expect((await repo.listPage("TENANT#none", { limit: 10 })).items).toEqual([]);
    expect(await repo.listAllByPartition("TENANT#none", { pageSize: 10, maxPages: 5 })).toEqual([]);
  });

  it("should not leak rows from a different tenant partition", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ pk: "TENANT#tenant-a" }));
    await repo.appendAudit(row({ pk: "TENANT#tenant-b" }));

    const page = await repo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(page.items.length).toBe(1);
    expect(page.items[0]?.pk).toBe("TENANT#tenant-a");
  });

  it("should prune rows whose ttl has expired and keep the rest", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ sk: "AUDIT#expired", ttl: 1000 }));
    await repo.appendAudit(row({ sk: "AUDIT#fresh", ttl: 9_999_999_999 }));
    commands.length = 0;

    const deleted = await repo.pruneExpired(5000);

    expect(deleted).toBe(1);
    expect(commands.some((c) => c instanceof DeleteCommand)).toBe(true);
    const remaining = await repo.listAllByPartition("TENANT#tenant-a", {
      pageSize: 10,
      maxPages: 5,
    });
    expect(remaining.map((r) => r.sk)).toEqual(["AUDIT#fresh"]);
  });

  it("should be a no-op when nothing has expired", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbAdminAuditLogRepository(ddb, TABLE);
    await repo.appendAudit(row({ ttl: 9_999_999_999 }));

    expect(await repo.pruneExpired(5000)).toBe(0);
  });
});

describe("SqlAdminAuditLogRepository", () => {
  it("should round-trip appendAudit/listPage through the SQLite backend, newest-first", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));

    const page = await repo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(page.items.map((r) => r.sk)).toEqual(["AUDIT#B", "AUDIT#A"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("should paginate with a keyset cursor", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));
    await repo.appendAudit(row({ sk: "AUDIT#C" }));

    const page1 = await repo.listPage("TENANT#tenant-a", { limit: 2 });
    expect(page1.items.map((r) => r.sk)).toEqual(["AUDIT#C", "AUDIT#B"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listPage("TENANT#tenant-a", { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.sk)).toEqual(["AUDIT#A"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("should reject an oversized or malformed cursor by starting from the top", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row());

    const page = await repo.listPage("TENANT#tenant-a", {
      limit: 10,
      cursor: "not-valid-base64url-json",
    });

    expect(page.items.length).toBe(1);
  });

  it("should drain every page in listAllByPartition", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row({ sk: "AUDIT#A" }));
    await repo.appendAudit(row({ sk: "AUDIT#B" }));
    await repo.appendAudit(row({ sk: "AUDIT#C" }));

    const rows = await repo.listAllByPartition("TENANT#tenant-a", { pageSize: 1, maxPages: 10 });

    expect(rows.map((r) => r.sk)).toEqual(["AUDIT#C", "AUDIT#B", "AUDIT#A"]);
  });

  it("should scope rows to their own partition", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row({ pk: "TENANT#tenant-a" }));
    await repo.appendAudit(row({ pk: "TENANT#tenant-b" }));

    const page = await repo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(page.items.length).toBe(1);
    expect(page.items[0]?.pk).toBe("TENANT#tenant-a");
  });

  it("should prune rows whose ttl has expired and keep the rest", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlAdminAuditLogRepository(sql);
    await repo.appendAudit(row({ sk: "AUDIT#expired", ttl: 1000 }));
    await repo.appendAudit(row({ sk: "AUDIT#fresh", ttl: 9_999_999_999 }));

    const deleted = await repo.pruneExpired(5000);

    expect(deleted).toBe(1);
    const remaining = await repo.listAllByPartition("TENANT#tenant-a", {
      pageSize: 10,
      maxPages: 5,
    });
    expect(remaining.map((r) => r.sk)).toEqual(["AUDIT#fresh"]);
  });
});

describe("DynamoDB / SQL parity", () => {
  it("should agree on listPage ordering and content for the same appended rows", async () => {
    const ddbRepo = new DynamoDbAdminAuditLogRepository(makeFakeDdb(), TABLE);
    const sqlRepo = new SqlAdminAuditLogRepository(makeSqliteExecutor());
    const rows = [row({ sk: "AUDIT#A" }), row({ sk: "AUDIT#B" }), row({ sk: "AUDIT#C" })];
    for (const r of rows) {
      await ddbRepo.appendAudit(r);
      await sqlRepo.appendAudit(r);
    }

    const ddbPage = await ddbRepo.listPage("TENANT#tenant-a", { limit: 10 });
    const sqlPage = await sqlRepo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(ddbPage.items.map((r) => r.sk)).toEqual(sqlPage.items.map((r) => r.sk));
  });
});

describe("createAdminAuditLogRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), adminAuditLogTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createAdminAuditLogRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbAdminAuditLogRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createAdminAuditLogRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbAdminAuditLogRepository,
    );
  });

  it("should select the SQL backend for turso and sql flags", () => {
    expect(createAdminAuditLogRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlAdminAuditLogRepository,
    );
    expect(createAdminAuditLogRepository("sql", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlAdminAuditLogRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createAdminAuditLogRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createAdminAuditLogRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createAdminAuditLogRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createAdminAuditLogRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("MirroredAdminAuditLogRepository", () => {
  it("should write-through appendAudit to both backends", async () => {
    const canonical = new DynamoDbAdminAuditLogRepository(makeFakeDdb(), TABLE);
    const replica = new SqlAdminAuditLogRepository(makeSqliteExecutor());
    const repo = new MirroredAdminAuditLogRepository(canonical, replica);

    await repo.appendAudit(row());

    await expect(replica.listPage("TENANT#tenant-a", { limit: 10 })).resolves.toMatchObject({
      items: [row()],
    });
  });

  it("should serve listPage / listAllByPartition from canonical only", async () => {
    const canonicalListPage = vi.fn(async () => ({ items: [row({ sk: "canonical" })] }));
    const replicaListPage = vi.fn(async () => ({ items: [row({ sk: "replica" })] }));
    const stub = (listPage: typeof canonicalListPage) => ({
      appendAudit: async () => {},
      listPage,
      listAllByPartition: async () => [],
      pruneExpired: async () => 0,
    });
    const repo = new MirroredAdminAuditLogRepository(
      stub(canonicalListPage),
      stub(replicaListPage),
    );

    const out = await repo.listPage("TENANT#tenant-a", { limit: 10 });

    expect(out.items[0]?.sk).toBe("canonical");
    expect(canonicalListPage).toHaveBeenCalled();
    expect(replicaListPage).not.toHaveBeenCalled();
  });

  it("should prune both backends and return the canonical count", async () => {
    const canonicalPrune = vi.fn(async () => 3);
    const replicaPrune = vi.fn(async () => 3);
    const stub = (pruneExpired: typeof canonicalPrune) => ({
      appendAudit: async () => {},
      listPage: async () => ({ items: [] }),
      listAllByPartition: async () => [],
      pruneExpired,
    });
    const repo = new MirroredAdminAuditLogRepository(stub(canonicalPrune), stub(replicaPrune));

    expect(await repo.pruneExpired(5000)).toBe(3);
    expect(canonicalPrune).toHaveBeenCalledWith(5000);
    expect(replicaPrune).toHaveBeenCalledWith(5000);
  });
});

describe("resolveAdminAuditLogRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveAdminAuditLogRepository({
      ddb: makeFakeDdb(),
      adminAuditLogTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbAdminAuditLogRepository);
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

    await expect(runtime.resolveAdminAuditLogRepository({})).resolves.toBeInstanceOf(
      SqlAdminAuditLogRepository,
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

    const repo = await runtime.resolveAdminAuditLogRepository({
      ddb: makeFakeDdb(),
      adminAuditLogTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(MirroredAdminAuditLogRepository);
  });

  it("should fail loudly when mirror/dynamodb backends are missing ddb/adminAuditLogTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "turso-mirror" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveAdminAuditLogRepository({ ddb: makeFakeDdb() })).rejects.toThrow(
      /mirror backend requires ddb\/adminAuditLogTableName/,
    );
  });
});
