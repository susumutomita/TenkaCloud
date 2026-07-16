import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  createProblemEndpointsRepository,
  DynamoDbProblemEndpointsRepository,
  SqlProblemEndpointsRepository,
} from "../../../lib/problem-deploy/control-data/problem-endpoints-repository";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import type { ProblemEndpointRecord } from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C1] DynamoDB byte-pin test suite for the ProblemEndpoints
 * seam — the smallest control-data table (no GSI, no conditional writes, no
 * Scan). Mirrors `deployments-repository.test.ts`'s structure: round-trip +
 * byte-pin for the DynamoDB backend, plus factory / runtime-resolver coverage
 * for both `CONTROL_DATA_BACKEND` values (dynamodb / turso, #2677).
 */

const TABLE = "ProblemEndpoints";

function record(over: Partial<ProblemEndpointRecord> = {}): ProblemEndpointRecord {
  return {
    tenantId: "tenant-a",
    teamId: "team-1",
    problemId: "p1",
    slot: "frontend",
    overrideUrl: "https://team.example.com/",
    updatedAt: "2026-07-08T12:00:00.000Z",
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

describe("DynamoDbProblemEndpointsRepository", () => {
  it("should Put an override row with the same PK/SK derivation as the pre-seam handler", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);

    await repo.putOverride(record());

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: {
        PK: "TENANT#tenant-a#TEAM#team-1#PROBLEM#p1",
        SK: "SLOT#frontend",
        ...record(),
      },
    });
  });

  it("should round-trip a put row through queryOverrides", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);

    await repo.putOverride(record());
    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");

    expect(rows).toEqual([record()]);
  });

  it("should scope queryOverrides to the (tenant, team, problem) triple via a base-table begins_with Query", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);
    await repo.putOverride(record({ slot: "frontend" }));
    await repo.putOverride(record({ slot: "api" }));
    await repo.putOverride(record({ teamId: "team-2", slot: "frontend" }));
    commands.length = 0;

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");

    expect(rows.map((r) => r.slot).sort()).toEqual(["api", "frontend"]);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.IndexName).toBeUndefined();
    expect(commands[0].input.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :sk)");
    expect(commands[0].input.ExpressionAttributeValues).toEqual({
      ":pk": "TENANT#tenant-a#TEAM#team-1#PROBLEM#p1",
      ":sk": "SLOT#",
    });
  });

  it("should return [] when no override rows exist", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);
    expect(await repo.queryOverrides("tenant-a", "team-1", "p1")).toEqual([]);
  });

  it("should Delete an override row with the same key derivation", async () => {
    const { ddb, commands } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);
    await repo.putOverride(record());
    commands.length = 0;

    await repo.deleteOverride("tenant-a", "team-1", "p1", "frontend");

    expect(commands[0]).toBeInstanceOf(DeleteCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Key: { PK: "TENANT#tenant-a#TEAM#team-1#PROBLEM#p1", SK: "SLOT#frontend" },
    });
    expect(await repo.queryOverrides("tenant-a", "team-1", "p1")).toEqual([]);
  });

  it("should overwrite an existing override on a repeat Put (upsert semantics)", async () => {
    const { ddb } = recording();
    const repo = new DynamoDbProblemEndpointsRepository(ddb, TABLE);
    await repo.putOverride(record({ overrideUrl: "https://old.example.com/" }));
    await repo.putOverride(record({ overrideUrl: "https://new.example.com/" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([record({ overrideUrl: "https://new.example.com/" })]);
  });
});

describe("SqlProblemEndpointsRepository", () => {
  it("should round-trip put/query through the SQLite backend", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlProblemEndpointsRepository(sql);

    await repo.putOverride(record());
    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");

    expect(rows).toEqual([record()]);
  });

  it("should upsert on a repeat put for the same primary key", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlProblemEndpointsRepository(sql);
    await repo.putOverride(record({ overrideUrl: "https://old.example.com/" }));
    await repo.putOverride(record({ overrideUrl: "https://new.example.com/" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows).toEqual([record({ overrideUrl: "https://new.example.com/" })]);
  });

  it("should delete an override row", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlProblemEndpointsRepository(sql);
    await repo.putOverride(record());

    await repo.deleteOverride("tenant-a", "team-1", "p1", "frontend");

    expect(await repo.queryOverrides("tenant-a", "team-1", "p1")).toEqual([]);
  });

  it("should scope queryOverrides to the (tenant, team, problem) triple, ordered by slot", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlProblemEndpointsRepository(sql);
    await repo.putOverride(record({ slot: "frontend" }));
    await repo.putOverride(record({ slot: "api" }));
    await repo.putOverride(record({ teamId: "team-2", slot: "frontend" }));

    const rows = await repo.queryOverrides("tenant-a", "team-1", "p1");
    expect(rows.map((r) => r.slot)).toEqual(["api", "frontend"]);
  });
});

describe("createProblemEndpointsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), endpointsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createProblemEndpointsRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbProblemEndpointsRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createProblemEndpointsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbProblemEndpointsRepository,
    );
  });

  it("should select the SQL backend for the turso flag", () => {
    expect(createProblemEndpointsRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlProblemEndpointsRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createProblemEndpointsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it.each([
    "postgres",
    "sql",
    "turso-mirror",
    "sql-mirror",
  ])("should reject the unknown backend value %s", (backend) => {
    expect(() => createProblemEndpointsRepository(backend, ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND.*expected one of: dynamodb, turso/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createProblemEndpointsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createProblemEndpointsRepository("dynamodb", { ddb: makeFakeDdb() })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("resolveProblemEndpointsRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveProblemEndpointsRepository({
      ddb: makeFakeDdb(),
      endpointsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbProblemEndpointsRepository);
  });

  it("should return the SQL backend for CONTROL_DATA_BACKEND=turso without DDB inputs", async () => {
    const runtime = createControlDataRuntime({
      env: {
        CONTROL_DATA_BACKEND: "turso",
        TURSO_DATABASE_URL: "file:local.db",
        TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/dev/sql-token",
      },
      ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: "secret-token" } }) },
      createClient: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0 }),
        batch: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(runtime.resolveProblemEndpointsRepository({})).resolves.toBeInstanceOf(
      SqlProblemEndpointsRepository,
    );
  });

  it("should fail loudly when the dynamodb backend is missing ddb/endpointsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "dynamodb" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveProblemEndpointsRepository({ ddb: makeFakeDdb() })).rejects.toThrow(
      /dynamodb backend requires ddb\/endpointsTableName/,
    );
  });
});
