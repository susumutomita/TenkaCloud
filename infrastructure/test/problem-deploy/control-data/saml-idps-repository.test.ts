import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SamlIdpConfig } from "@tenkacloud/saml-utils";
import { describe, expect, it, vi } from "vitest";
import type { IdpScope } from "../../../lib/control-plane/handlers/idp-handler/core";
import { createControlDataRuntime } from "../../../lib/problem-deploy/control-data/runtime-repositories";
import {
  createSamlIdpsRepository,
  DynamoDbSamlIdpsRepository,
  SqlSamlIdpsRepository,
} from "../../../lib/problem-deploy/control-data/saml-idps-repository";
import { makeSqliteExecutor } from "./control-data-write.test-helpers";

/**
 * [Issue #2442 / Phase C5] Byte-pin test suite for the SamlIdps seam — the smallest
 * control-data aggregate (no GSI, no conditional writes, no Scan; but **lower-case**
 * `pk`/`sk` physical keys, unlike every other table in this file's siblings).
 *
 * `makeFakeDdb()` from `control-data-write.test-helpers.ts` hard-codes upper-case
 * `PK`/`SK` in its `keyOf`/`put`/`get`/`del` handlers, so it cannot back this
 * repository — a bespoke lower-case-keyed fake lives below instead (the exact
 * "difference from every other table" the issue calls out).
 */

const TABLE = "SamlIdps";

function record(over: Partial<SamlIdpConfig> = {}): SamlIdpConfig {
  return {
    idpId: "okta",
    displayName: "Okta",
    metadataXml: "<EntityDescriptor/>",
    attributeMapping: { email: "email" },
    groupToRole: { admins: "TenantAdmin" },
    tenantId: "tenant-a",
    createdAt: "2026-07-08T12:00:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
    ...over,
  };
}

const tenantScope = (tenantId = "tenant-a"): IdpScope => ({ kind: "tenant", tenantId });
const systemScope: IdpScope = { kind: "system" };

/** Lower-case-keyed fake DocumentClient (pk/sk), scoped to one table. */
function makeFakeIdpDdb(): {
  ddb: DynamoDBDocumentClient;
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands for byte-pin assertions.
  commands: any[];
} {
  const store = new Map<string, Record<string, unknown>>();
  // biome-ignore lint/suspicious/noExplicitAny: capture raw Commands for byte-pin assertions.
  const commands: any[] = [];
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)} ${String(sk)}`;

  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command class.
  const send = async (cmd: any): Promise<unknown> => {
    commands.push(cmd);
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Record<string, unknown>;
      store.set(keyOf(item.pk, item.sk), item);
      return {};
    }
    if (cmd instanceof GetCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      return { Item: store.get(keyOf(key.pk, key.sk)) };
    }
    if (cmd instanceof DeleteCommand) {
      const key = cmd.input.Key as Record<string, unknown>;
      store.delete(keyOf(key.pk, key.sk));
      return {};
    }
    if (cmd instanceof QueryCommand) {
      const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
      const items = [...store.values()].filter((it) => it.pk === pk);
      return { Items: items };
    }
    throw new Error(`FakeIdpDdb: unsupported command ${cmd?.constructor?.name}`);
  };

  return { ddb: { send } as unknown as DynamoDBDocumentClient, commands };
}

describe("DynamoDbSamlIdpsRepository", () => {
  it("should Put an IdP row keyed by lower-case pk/sk (pk=tenantId for a tenant scope)", async () => {
    const { ddb, commands } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);

    await repo.put(tenantScope(), record());

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Item: { pk: "tenant-a", sk: "okta", ...record() },
    });
  });

  it("should Put an IdP row keyed by pk=SYSTEM for a system scope", async () => {
    const { ddb, commands } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);

    await repo.put(systemScope, record({ tenantId: undefined }));

    expect(commands[0].input.Item.pk).toBe("SYSTEM");
    expect(commands[0].input.Item.sk).toBe("okta");
  });

  it("should round-trip a put row through get", async () => {
    const { ddb } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);

    await repo.put(tenantScope(), record());
    expect(await repo.get(tenantScope(), "okta")).toEqual(record());
  });

  it("should return null (not undefined) when the row is absent", async () => {
    const { ddb } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);
    expect(await repo.get(tenantScope(), "missing")).toBeNull();
  });

  it("should scope list to the exact pk via a base-table Query with no IndexName", async () => {
    const { ddb, commands } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);
    await repo.put(tenantScope(), record({ idpId: "okta" }));
    await repo.put(tenantScope(), record({ idpId: "azure" }));
    await repo.put(tenantScope("tenant-b"), record({ idpId: "okta", tenantId: "tenant-b" }));
    commands.length = 0;

    const rows = await repo.list(tenantScope());

    expect(rows.map((r) => r.idpId).sort()).toEqual(["azure", "okta"]);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input.IndexName).toBeUndefined();
    expect(commands[0].input.KeyConditionExpression).toBe("pk = :pk");
    expect(commands[0].input.ExpressionAttributeValues).toEqual({ ":pk": "tenant-a" });
  });

  it("should return [] when no rows exist for a scope", async () => {
    const { ddb } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);
    expect(await repo.list(tenantScope())).toEqual([]);
  });

  it("should Delete a row keyed by the same pk/sk derivation", async () => {
    const { ddb, commands } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);
    await repo.put(tenantScope(), record());
    commands.length = 0;

    await repo.delete(tenantScope(), "okta");

    expect(commands[0]).toBeInstanceOf(DeleteCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      Key: { pk: "tenant-a", sk: "okta" },
    });
    expect(await repo.get(tenantScope(), "okta")).toBeNull();
  });

  it("should overwrite an existing row on a repeat put (upsert semantics)", async () => {
    const { ddb } = makeFakeIdpDdb();
    const repo = new DynamoDbSamlIdpsRepository(ddb, TABLE);
    await repo.put(tenantScope(), record({ displayName: "Old" }));
    await repo.put(tenantScope(), record({ displayName: "New" }));

    expect(await repo.get(tenantScope(), "okta")).toEqual(record({ displayName: "New" }));
  });
});

describe("SqlSamlIdpsRepository", () => {
  it("should round-trip put/get through the SQLite backend", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);

    await repo.put(tenantScope(), record());
    expect(await repo.get(tenantScope(), "okta")).toEqual(record());
  });

  it("should return null when the row is absent", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);
    expect(await repo.get(tenantScope(), "missing")).toBeNull();
  });

  it("should upsert on a repeat put for the same (scope, idpId)", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);
    await repo.put(tenantScope(), record({ displayName: "Old" }));
    await repo.put(tenantScope(), record({ displayName: "New" }));

    expect(await repo.get(tenantScope(), "okta")).toEqual(record({ displayName: "New" }));
  });

  it("should delete a row", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);
    await repo.put(tenantScope(), record());

    await repo.delete(tenantScope(), "okta");

    expect(await repo.get(tenantScope(), "okta")).toBeNull();
  });

  it("should scope list to the exact scope, ordered by idpId", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);
    await repo.put(tenantScope(), record({ idpId: "okta" }));
    await repo.put(tenantScope(), record({ idpId: "azure" }));
    await repo.put(tenantScope("tenant-b"), record({ idpId: "okta", tenantId: "tenant-b" }));

    const rows = await repo.list(tenantScope());
    expect(rows.map((r) => r.idpId)).toEqual(["azure", "okta"]);
  });

  it("should keep system and tenant scopes disjoint", async () => {
    const sql = makeSqliteExecutor();
    const repo = new SqlSamlIdpsRepository(sql);
    await repo.put(systemScope, record({ idpId: "okta", tenantId: undefined }));
    await repo.put(tenantScope(), record({ idpId: "okta" }));

    expect(await repo.list(systemScope)).toEqual([record({ idpId: "okta", tenantId: undefined })]);
    expect(await repo.list(tenantScope())).toEqual([record({ idpId: "okta" })]);
  });
});

describe("createSamlIdpsRepository", () => {
  const ddbDeps = () => ({ ddb: makeFakeIdpDdb().ddb, samlIdpsTableName: TABLE });

  it("should default to the DynamoDB backend when the flag is unset", () => {
    expect(createSamlIdpsRepository(undefined, ddbDeps())).toBeInstanceOf(
      DynamoDbSamlIdpsRepository,
    );
  });

  it("should select DynamoDB for an explicit (case-insensitive) dynamodb flag", () => {
    expect(createSamlIdpsRepository("DynamoDB", ddbDeps())).toBeInstanceOf(
      DynamoDbSamlIdpsRepository,
    );
  });

  it("should select the SQL backend for the turso flag", () => {
    expect(createSamlIdpsRepository("turso", { sql: makeSqliteExecutor() })).toBeInstanceOf(
      SqlSamlIdpsRepository,
    );
  });

  it("should fail loudly when the SQL backend is selected without a SqlExecutor", () => {
    expect(() => createSamlIdpsRepository("turso", {})).toThrow(/requires a SqlExecutor/);
  });

  it("should reject an unknown backend value", () => {
    expect(() => createSamlIdpsRepository("postgres", ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND/,
    );
  });

  it.each([
    "sql",
    "turso-mirror",
    "sql-mirror",
  ])("should reject the removed %s backend value (#2677)", (backend) => {
    expect(() => createSamlIdpsRepository(backend, ddbDeps())).toThrow(
      /Unknown CONTROL_DATA_BACKEND.*expected one of: dynamodb, turso/,
    );
  });

  it("should fail loudly when DynamoDB deps are missing", () => {
    expect(() => createSamlIdpsRepository("dynamodb", {})).toThrow(/requires deps.ddb/);
    expect(() => createSamlIdpsRepository("dynamodb", { ddb: makeFakeIdpDdb().ddb })).toThrow(
      /requires deps.ddb/,
    );
  });
});

describe("resolveSamlIdpsRepository (runtime)", () => {
  it("should return the DynamoDB backend by default (no CONTROL_DATA_BACKEND)", async () => {
    const runtime = createControlDataRuntime({
      env: {},
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    const repo = await runtime.resolveSamlIdpsRepository({
      ddb: makeFakeIdpDdb().ddb,
      samlIdpsTableName: TABLE,
    });
    expect(repo).toBeInstanceOf(DynamoDbSamlIdpsRepository);
  });

  it.each([
    "turso",
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

    await expect(runtime.resolveSamlIdpsRepository({})).resolves.toBeInstanceOf(
      SqlSamlIdpsRepository,
    );
  });

  it("should fail loudly when the dynamodb backend is missing ddb/samlIdpsTableName", async () => {
    const runtime = createControlDataRuntime({
      env: { CONTROL_DATA_BACKEND: "dynamodb" },
      ssm: { send: vi.fn() },
      createClient: vi.fn(),
    });

    await expect(runtime.resolveSamlIdpsRepository({ ddb: makeFakeIdpDdb().ddb })).rejects.toThrow(
      /dynamodb backend requires ddb\/samlIdpsTableName/,
    );
  });
});
