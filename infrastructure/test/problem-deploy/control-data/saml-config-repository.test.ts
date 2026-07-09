import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { MirroredSamlConfigRepository } from "../../../lib/problem-deploy/control-data/mirrored-repositories";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import {
  createSamlConfigRepository,
  DynamoDbSamlConfigRepository,
  SqlSamlConfigRepository,
} from "../../../lib/problem-deploy/control-data/saml-config-repository";
import type {
  SamlConfigRecord,
  SamlConfigRepository,
} from "../../../lib/problem-deploy/control-data/types";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C2] Round-trip + byte-pin suite for the SamlConfig
 * sub-aggregate (a sparse `SK = "SAML_CONFIG"` row co-habiting the
 * CompetitorAccounts DynamoDB partition, but its own SQL table — mirrors
 * `feature-flags-repository-parity.test.ts`'s structure).
 */

const TABLE = "CompetitorAccounts";

function sampleRecord(overrides: Partial<SamlConfigRecord> = {}): SamlConfigRecord {
  return {
    tenantId: "tenant-a",
    metadataUrl: "https://idp.example.com/metadata.xml",
    providerName: "AcmeSAML",
    attributeMapping: { email: "http://schemas.xmlsoap.org/claims/emailaddress" },
    enforceSamlOnly: false,
    updatedAt: "2026-07-08T00:00:00.000Z",
    updatedBy: "operator-sub",
    ...overrides,
  };
}

const backends: ReadonlyArray<readonly [string, () => SamlConfigRepository]> = [
  ["DynamoDbSamlConfigRepository", () => new DynamoDbSamlConfigRepository(makeFakeDdb(), TABLE)],
  ["SqlSamlConfigRepository", () => new SqlSamlConfigRepository(makeSqliteExecutor())],
];

describe.each(backends)("SamlConfigRepository parity: %s", (_name, makeRepo) => {
  it("should return undefined for a tenant that never configured SAML", async () => {
    const repo = makeRepo();
    await expect(repo.getSamlConfig("tenant-missing")).resolves.toBeUndefined();
  });

  it("should round-trip put then get", async () => {
    const repo = makeRepo();
    const record = sampleRecord();

    await repo.putSamlConfig(record);

    await expect(repo.getSamlConfig(record.tenantId)).resolves.toEqual(record);
  });

  it("should full-replace on second put", async () => {
    const repo = makeRepo();
    await repo.putSamlConfig(sampleRecord({ enforceSamlOnly: false }));
    await repo.putSamlConfig(
      sampleRecord({ enforceSamlOnly: true, updatedAt: "2026-07-08T01:00:00.000Z" }),
    );

    const got = await repo.getSamlConfig("tenant-a");
    expect(got).toEqual(
      sampleRecord({ enforceSamlOnly: true, updatedAt: "2026-07-08T01:00:00.000Z" }),
    );
  });

  it("should delete idempotently (no-op when already absent)", async () => {
    const repo = makeRepo();
    await repo.putSamlConfig(sampleRecord());

    await repo.deleteSamlConfig("tenant-a");
    await expect(repo.getSamlConfig("tenant-a")).resolves.toBeUndefined();
    await expect(repo.deleteSamlConfig("tenant-a")).resolves.toBeUndefined();
  });

  it("should not leak another tenant's config", async () => {
    const repo = makeRepo();
    await repo.putSamlConfig(sampleRecord({ tenantId: "tenant-a", providerName: "AProvider" }));
    await repo.putSamlConfig(sampleRecord({ tenantId: "tenant-b", providerName: "BProvider" }));

    await expect(repo.getSamlConfig("tenant-a")).resolves.toEqual(
      sampleRecord({ tenantId: "tenant-a", providerName: "AProvider" }),
    );
  });
});

describe("DynamoDbSamlConfigRepository physical row", () => {
  it("should keep the DDB SAML_CONFIG row byte-identical to the pre-seam writer (no redundant tenantId attribute)", async () => {
    const ddb = makeFakeDdb();
    const repo = new DynamoDbSamlConfigRepository(ddb, TABLE);
    const record = sampleRecord();

    await repo.putSamlConfig(record);

    const out = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `TENANT#${record.tenantId}`, SK: "SAML_CONFIG" },
      }),
    );
    expect(out.Item).toEqual({
      PK: `TENANT#${record.tenantId}`,
      SK: "SAML_CONFIG",
      metadataUrl: record.metadataUrl,
      providerName: record.providerName,
      attributeMapping: record.attributeMapping,
      enforceSamlOnly: record.enforceSamlOnly,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    });
    expect(out.Item).not.toHaveProperty("tenantId");
  });
});

describe("MirroredSamlConfigRepository", () => {
  function memorySamlConfig(initial: readonly SamlConfigRecord[] = []): {
    readonly repo: SamlConfigRepository;
    readonly records: Map<string, SamlConfigRecord>;
  } {
    const records = new Map(initial.map((record) => [record.tenantId, record]));
    return {
      records,
      repo: {
        getSamlConfig: async (tenantId) => records.get(tenantId),
        putSamlConfig: async (record) => {
          records.set(record.tenantId, record);
          return record;
        },
        deleteSamlConfig: async (tenantId) => {
          records.delete(tenantId);
        },
      },
    };
  }

  it("should write through on put", async () => {
    const canonical = memorySamlConfig();
    const replica = memorySamlConfig();
    const repository = new MirroredSamlConfigRepository(canonical.repo, replica.repo);
    const record = sampleRecord();

    await repository.putSamlConfig(record);

    expect(canonical.records.get(record.tenantId)).toEqual(record);
    expect(replica.records.get(record.tenantId)).toEqual(record);
  });

  it("should write through on delete", async () => {
    const record = sampleRecord();
    const canonical = memorySamlConfig([record]);
    const replica = memorySamlConfig([record]);
    const repository = new MirroredSamlConfigRepository(canonical.repo, replica.repo);

    await repository.deleteSamlConfig(record.tenantId);

    expect(canonical.records.has(record.tenantId)).toBe(false);
    expect(replica.records.has(record.tenantId)).toBe(false);
  });

  it("should serve get from canonical only", async () => {
    const canonicalGet = vi.fn(async () => sampleRecord({ providerName: "Canonical" }));
    const replicaGet = vi.fn(async () => sampleRecord({ providerName: "Replica" }));
    const repository = new MirroredSamlConfigRepository(
      {
        getSamlConfig: canonicalGet,
        putSamlConfig: async (r) => r,
        deleteSamlConfig: async () => {},
      },
      {
        getSamlConfig: replicaGet,
        putSamlConfig: async (r) => r,
        deleteSamlConfig: async () => {},
      },
    );

    const record = await repository.getSamlConfig("tenant-a");

    expect(record?.providerName).toBe("Canonical");
    expect(canonicalGet).toHaveBeenCalledWith("tenant-a");
    expect(replicaGet).not.toHaveBeenCalled();
  });
});

describe("createSamlConfigRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeDdb(), competitorAccountsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createSamlConfigRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbSamlConfigRepository,
    );
  });

  it("should select the SQL backend for turso and sql flags", () => {
    expect(createSamlConfigRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlSamlConfigRepository,
    );
    expect(createSamlConfigRepository("sql", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlSamlConfigRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createSamlConfigRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createSamlConfigRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createSamlConfigRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
  });
});

describe("resolveSamlConfigRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveSamlConfigRepository({
      ddb: makeFakeDdb(),
      competitorAccountsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbSamlConfigRepository);
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

    await expect(runtime.resolveSamlConfigRepository({})).resolves.toBeInstanceOf(
      SqlSamlConfigRepository,
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

    const repo = await runtime.resolveSamlConfigRepository({
      ddb: makeFakeDdb(),
      competitorAccountsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(MirroredSamlConfigRepository);
  });

  it("should fail loudly when mirror/dynamodb backends are missing ddb/competitorAccountsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "turso-mirror" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveSamlConfigRepository({ ddb: makeFakeDdb() })).rejects.toThrow(
      /mirror backend requires ddb\/competitorAccountsTableName/,
    );
  });
});
