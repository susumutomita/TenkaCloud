import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DynamoDbFeatureFlagsRepository,
  type FeatureFlagsRepository,
  SqlFeatureFlagsRepository,
  type TenantFeatureFlagsRecord,
} from "../../../lib/problem-deploy/control-data/feature-flags-repository";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

const TABLE = "Events";

function sampleRecord(overrides: Partial<TenantFeatureFlagsRecord> = {}): TenantFeatureFlagsRecord {
  return {
    tenantId: "tenant-a",
    flags: { challengePrerequisiteGate: true, bonusRound: false },
    updatedAt: "2026-07-08T00:00:00.000Z",
    updatedBy: "operator-sub",
    ...overrides,
  };
}

const backends: ReadonlyArray<readonly [string, () => FeatureFlagsRepository]> = [
  [
    "DynamoDbFeatureFlagsRepository",
    () => new DynamoDbFeatureFlagsRepository(makeFakeDdb(), TABLE),
  ],
  ["SqlFeatureFlagsRepository", () => new SqlFeatureFlagsRepository(makeSqliteExecutor())],
];

describe.each(backends)("FeatureFlagsRepository parity: %s", (_name, makeRepo) => {
  it("should return undefined for a tenant that never saved flags", async () => {
    const repo = makeRepo();
    await expect(repo.get("tenant-missing")).resolves.toBeUndefined();
  });

  it("should round-trip put then get", async () => {
    const repo = makeRepo();
    const record = sampleRecord();

    await repo.put(record);

    await expect(repo.get(record.tenantId)).resolves.toEqual(record);
  });

  it("should full-replace on second put", async () => {
    const repo = makeRepo();
    await repo.put(sampleRecord({ flags: { staleFlag: true, keptFlag: true } }));
    await repo.put(
      sampleRecord({
        flags: { keptFlag: false },
        updatedAt: "2026-07-08T01:00:00.000Z",
        updatedBy: "operator-two",
      }),
    );

    const got = await repo.get("tenant-a");

    expect(got).toEqual(
      sampleRecord({
        flags: { keptFlag: false },
        updatedAt: "2026-07-08T01:00:00.000Z",
        updatedBy: "operator-two",
      }),
    );
    expect(got?.flags).not.toHaveProperty("staleFlag");
  });

  it("should not leak another tenant's flags", async () => {
    const repo = makeRepo();
    await repo.put(sampleRecord({ tenantId: "tenant-a", flags: { aOnly: true } }));
    await repo.put(sampleRecord({ tenantId: "tenant-b", flags: { bOnly: true } }));

    await expect(repo.get("tenant-a")).resolves.toEqual(
      sampleRecord({ tenantId: "tenant-a", flags: { aOnly: true } }),
    );
  });
});

describe("DynamoDbFeatureFlagsRepository physical row", () => {
  it("should keep the DynamoDB feature-flags row byte-identical to the pre-seam writer", async () => {
    const ddb = makeFakeDdb();
    const repo = new DynamoDbFeatureFlagsRepository(ddb, TABLE);
    const record = sampleRecord();

    await repo.put(record);

    const out = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `TENANT#${record.tenantId}`, SK: "FLAGS" },
      }),
    );
    expect(out.Item).toEqual({
      PK: `TENANT#${record.tenantId}`,
      SK: "FLAGS",
      ...record,
    });
  });
});
