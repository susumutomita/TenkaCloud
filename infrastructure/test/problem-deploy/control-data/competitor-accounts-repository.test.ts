import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  createCompetitorAccountsRepository,
  DynamoDbCompetitorAccountsRepository,
  SqlCompetitorAccountsRepository,
} from "../../../lib/problem-deploy/control-data/competitor-accounts-repository";
import { MirroredCompetitorAccountsRepository } from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import type { CompetitorAccountRecord } from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C2] DynamoDB byte-pin + SQLite round-trip test suite for
 * the CompetitorAccounts seam. Mirrors `problem-endpoints-repository.test.ts`'s
 * structure: byte-pin for the DynamoDB backend (conditional writes included),
 * SQL round-trip, factory / runtime-resolver coverage for all five
 * `CONTROL_DATA_BACKEND` values.
 */

const TABLE = "CompetitorAccounts";

function record(over: Partial<CompetitorAccountRecord> = {}): CompetitorAccountRecord {
  return {
    tenantId: "tenant-acme",
    awsAccountId: "222222222222",
    region: "ap-northeast-1",
    competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
    verified: false,
    createdAt: "2026-07-08T12:00:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
    createdBy: "user-sub-1",
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

describe("DynamoDbCompetitorAccountsRepository", () => {
  it("should Put a new account row with a duplicate-prevention ConditionExpression", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);

    const outcome = await repo.createAccount(record());

    expect(outcome).toEqual({ outcome: "created" });
    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: { PK: "TENANT#tenant-acme", SK: "ACCOUNT#222222222222", ...record() },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    });
  });

  it("should return conflict on a duplicate (tenantId, awsAccountId) without throwing", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record());

    const outcome = await repo.createAccount(record());

    expect(outcome).toEqual({ outcome: "conflict" });
  });

  it("should round-trip a created row through getAccount", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record());

    const out = await repo.getAccount("tenant-acme", "222222222222");
    expect(out).toEqual(record());
  });

  it("should return undefined from getAccount when the row is absent", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    expect(await repo.getAccount("tenant-acme", "999999999999")).toBeUndefined();
  });

  it("should list every account row for a tenant via a base-table begins_with Query", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record({ awsAccountId: "111111111111" }));
    await repo.createAccount(record({ awsAccountId: "222222222222" }));
    await repo.createAccount(record({ tenantId: "tenant-other", awsAccountId: "333333333333" }));
    commands.length = 0;

    const out = await repo.listAccounts("tenant-acme");

    expect(out.map((r) => r.awsAccountId).sort()).toEqual(["111111111111", "222222222222"]);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.IndexName).toBeUndefined();
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :sk)");
    expect(commands[0].input.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#tenant-acme",
      ":sk": "ACCOUNT#",
    });
  });

  it("should markVerified via UpdateCommand with an existence ConditionExpression and ALL_NEW", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record());
    commands.length = 0;

    const outcome = await repo.markVerified(
      "tenant-acme",
      "222222222222",
      "2026-07-08T13:00:00.000Z",
    );

    expect(commands[0]).toBeInstanceOf(UpdateCommand);
    expect(commands[0].input.ConditionExpression).toBe(
      "attribute_exists(PK) AND attribute_exists(SK)",
    );
    expect(commands[0].input.UpdateExpression).toBe(
      "SET verified = :v, verifiedAt = :va, updatedAt = :ua",
    );
    expect(commands[0].input.ReturnValues).toBe("ALL_NEW");
    expect(outcome).toEqual({
      outcome: "updated",
      record: record({
        verified: true,
        verifiedAt: "2026-07-08T13:00:00.000Z",
        updatedAt: "2026-07-08T13:00:00.000Z",
      }),
    });
  });

  it("should return not_found from markVerified when the row is absent", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    const outcome = await repo.markVerified(
      "tenant-acme",
      "999999999999",
      "2026-07-08T13:00:00.000Z",
    );
    expect(outcome).toEqual({ outcome: "not_found" });
  });

  it("should deleteAccount via DeleteCommand with an existence ConditionExpression", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record());
    commands.length = 0;

    const outcome = await repo.deleteAccount("tenant-acme", "222222222222");

    expect(outcome).toEqual({ outcome: "updated" });
    expect(commands[0]).toBeInstanceOf(DeleteCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Key: { PK: "TENANT#tenant-acme", SK: "ACCOUNT#222222222222" },
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
    });
    expect(await repo.getAccount("tenant-acme", "222222222222")).toBeUndefined();
  });

  it("should return not_found from deleteAccount when the row is absent", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    expect(await repo.deleteAccount("tenant-acme", "999999999999")).toEqual({
      outcome: "not_found",
    });
  });

  it("should report hasRemainingAccounts via a Select=COUNT Limit=1 Query", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    expect(await repo.hasRemainingAccounts("tenant-acme")).toBe(false);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.Select).toBe("COUNT");
    expect(commands[0].input.Limit).toBe(1);

    await repo.createAccount(record());
    expect(await repo.hasRemainingAccounts("tenant-acme")).toBe(true);
    expect(await repo.hasRemainingAccounts("tenant-other")).toBe(false);
  });

  it("should Scan with the rotation-audit ProjectionExpression via forEachCompetitorAccountPage", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record());
    commands.length = 0;

    const pages: unknown[][] = [];
    await repo.forEachCompetitorAccountPage(async (items) => {
      pages.push([...items]);
    });

    expect(commands[0]).toBeInstanceOf(ScanCommand);
    expect(commands[0].input.ProjectionExpression).toBe(
      "tenantId, awsAccountId, rotatedAt, createdAt",
    );
    expect(commands[0].input.ExclusiveStartKey).toBeUndefined();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([
      {
        PK: "TENANT#tenant-acme",
        SK: "ACCOUNT#222222222222",
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-07-08T12:00:00.000Z",
        updatedAt: "2026-07-08T12:00:00.000Z",
        createdBy: "user-sub-1",
      },
    ]);
  });

  it("should call onPage once per page when the Scan is paginated", async () => {
    const ddb = makeFakeDdb({ pageSize: 1 });
    const repo = new DynamoDbCompetitorAccountsRepository(ddb, TABLE);
    await repo.createAccount(record({ awsAccountId: "111111111111" }));
    await repo.createAccount(record({ awsAccountId: "222222222222" }));

    const pageCounts: number[] = [];
    await repo.forEachCompetitorAccountPage(async (items) => {
      pageCounts.push(items.length);
    });

    expect(pageCounts).toEqual([1, 1]);
  });
});

describe("SqlCompetitorAccountsRepository", () => {
  it("should round-trip create/get through the SQLite backend", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);

    const outcome = await repo.createAccount(record());
    expect(outcome).toEqual({ outcome: "created" });

    const out = await repo.getAccount("tenant-acme", "222222222222");
    expect(out).toEqual(record());
  });

  it("should return conflict on a duplicate (tenantId, awsAccountId) without throwing", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    await repo.createAccount(record());

    expect(await repo.createAccount(record())).toEqual({ outcome: "conflict" });
  });

  it("should list accounts for a tenant only, ordered by awsAccountId", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    await repo.createAccount(record({ awsAccountId: "222222222222" }));
    await repo.createAccount(record({ awsAccountId: "111111111111" }));
    await repo.createAccount(record({ tenantId: "tenant-other", awsAccountId: "999999999999" }));

    const out = await repo.listAccounts("tenant-acme");
    expect(out.map((r) => r.awsAccountId)).toEqual(["111111111111", "222222222222"]);
  });

  it("should markVerified and return the post-image", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    await repo.createAccount(record());

    const outcome = await repo.markVerified(
      "tenant-acme",
      "222222222222",
      "2026-07-08T13:00:00.000Z",
    );

    expect(outcome).toEqual({
      outcome: "updated",
      record: record({
        verified: true,
        verifiedAt: "2026-07-08T13:00:00.000Z",
        updatedAt: "2026-07-08T13:00:00.000Z",
      }),
    });
  });

  it("should return not_found from markVerified when the row is absent", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    expect(
      await repo.markVerified("tenant-acme", "999999999999", "2026-07-08T13:00:00.000Z"),
    ).toEqual({ outcome: "not_found" });
  });

  it("should deleteAccount and report not_found on a repeat delete", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    await repo.createAccount(record());

    expect(await repo.deleteAccount("tenant-acme", "222222222222")).toEqual({
      outcome: "updated",
    });
    expect(await repo.deleteAccount("tenant-acme", "222222222222")).toEqual({
      outcome: "not_found",
    });
  });

  it("should report hasRemainingAccounts", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    expect(await repo.hasRemainingAccounts("tenant-acme")).toBe(false);
    await repo.createAccount(record());
    expect(await repo.hasRemainingAccounts("tenant-acme")).toBe(true);
    expect(await repo.hasRemainingAccounts("tenant-other")).toBe(false);
  });

  it("should call onPage once with every row's rotation-audit projection", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlCompetitorAccountsRepository(sql);
    await repo.createAccount(record({ awsAccountId: "111111111111" }));
    await repo.createAccount(record({ awsAccountId: "222222222222" }));

    const pages: unknown[][] = [];
    await repo.forEachCompetitorAccountPage(async (items) => {
      pages.push([...items]);
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([
      {
        tenantId: "tenant-acme",
        awsAccountId: "111111111111",
        rotatedAt: undefined,
        createdAt: "2026-07-08T12:00:00.000Z",
      },
      {
        tenantId: "tenant-acme",
        awsAccountId: "222222222222",
        rotatedAt: undefined,
        createdAt: "2026-07-08T12:00:00.000Z",
      },
    ]);
  });
});

describe("MirroredCompetitorAccountsRepository", () => {
  it("should apply createAccount to the replica only when canonical succeeds", async () => {
    const canonical = new DynamoDbCompetitorAccountsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlCompetitorAccountsRepository(makeSqliteExecutor());
    const repo = new MirroredCompetitorAccountsRepository(canonical, replica);

    expect(await repo.createAccount(record())).toEqual({ outcome: "created" });
    await expect(replica.getAccount("tenant-acme", "222222222222")).resolves.toEqual(record());

    // A duplicate create fails on canonical (DDB) — the replica must not see a second write.
    expect(await repo.createAccount(record())).toEqual({ outcome: "conflict" });
  });

  it("should apply markVerified to the replica only when canonical finds the row", async () => {
    const canonical = new DynamoDbCompetitorAccountsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlCompetitorAccountsRepository(makeSqliteExecutor());
    const repo = new MirroredCompetitorAccountsRepository(canonical, replica);
    await repo.createAccount(record());

    const outcome = await repo.markVerified(
      "tenant-acme",
      "222222222222",
      "2026-07-08T13:00:00.000Z",
    );

    expect(outcome.outcome).toBe("updated");
    await expect(replica.getAccount("tenant-acme", "222222222222")).resolves.toMatchObject({
      verified: true,
    });

    expect(
      await repo.markVerified("tenant-acme", "999999999999", "2026-07-08T13:00:00.000Z"),
    ).toEqual({ outcome: "not_found" });
  });

  it("should apply deleteAccount to the replica only when canonical finds the row", async () => {
    const canonical = new DynamoDbCompetitorAccountsRepository(makeFakeDdb(), TABLE);
    const replica = new SqlCompetitorAccountsRepository(makeSqliteExecutor());
    const repo = new MirroredCompetitorAccountsRepository(canonical, replica);
    await repo.createAccount(record());

    expect(await repo.deleteAccount("tenant-acme", "222222222222")).toEqual({
      outcome: "updated",
    });
    await expect(replica.getAccount("tenant-acme", "222222222222")).resolves.toBeUndefined();
    expect(await repo.deleteAccount("tenant-acme", "222222222222")).toEqual({
      outcome: "not_found",
    });
  });

  it("should serve reads from canonical only", async () => {
    const canonicalGet = vi.fn(async () => record({ alias: "canonical" }));
    const replicaGet = vi.fn(async () => record({ alias: "replica" }));
    const stub = (get: typeof canonicalGet) => ({
      createAccount: async () => ({ outcome: "created" as const }),
      listAccounts: async () => [],
      getAccount: get,
      markVerified: async () => ({ outcome: "not_found" as const }),
      deleteAccount: async () => ({ outcome: "not_found" as const }),
      hasRemainingAccounts: async () => false,
      forEachCompetitorAccountPage: async () => {},
    });
    const repo = new MirroredCompetitorAccountsRepository(stub(canonicalGet), stub(replicaGet));

    const out = await repo.getAccount("tenant-acme", "222222222222");

    expect(out?.alias).toBe("canonical");
    expect(canonicalGet).toHaveBeenCalledWith("tenant-acme", "222222222222");
    expect(replicaGet).not.toHaveBeenCalled();
  });
});

describe("createCompetitorAccountsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), competitorAccountsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createCompetitorAccountsRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbCompetitorAccountsRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createCompetitorAccountsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbCompetitorAccountsRepository,
    );
  });

  it("should select the SQL backend for turso and sql flags", () => {
    expect(
      createCompetitorAccountsRepository("turso", { sql: makeSqliteExecutor() }),
    ).toBeInstanceOf(SqlCompetitorAccountsRepository);
    expect(createCompetitorAccountsRepository("sql", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlCompetitorAccountsRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createCompetitorAccountsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createCompetitorAccountsRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createCompetitorAccountsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createCompetitorAccountsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("resolveCompetitorAccountsRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveCompetitorAccountsRepository({
      ddb: makeFakeDdb(),
      competitorAccountsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbCompetitorAccountsRepository);
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

    await expect(runtime.resolveCompetitorAccountsRepository({})).resolves.toBeInstanceOf(
      SqlCompetitorAccountsRepository,
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

    const repo = await runtime.resolveCompetitorAccountsRepository({
      ddb: makeFakeDdb(),
      competitorAccountsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(MirroredCompetitorAccountsRepository);
  });

  it("should fail loudly when mirror/dynamodb backends are missing ddb/competitorAccountsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "turso-mirror" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(
      runtime.resolveCompetitorAccountsRepository({ ddb: makeFakeDdb() }),
    ).rejects.toThrow(/mirror backend requires ddb\/competitorAccountsTableName/);
  });
});
