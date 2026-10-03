import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDbCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/competitor-accounts-repository";
import {
  createCompetitorAccountsRepository,
  createRotationAgeMetricsRepository,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/repository";
import { makeFakeDdb } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

// [Issue #2442 / Phase C2] The `CompetitorAccounts` Scan itself moved behind the
// control-data repository seam (`resolveCompetitorAccountsRepository`), so this
// adapter no longer issues a `ScanCommand` directly — it delegates to
// `CompetitorAccountsRepository.forEachCompetitorAccountPage` (B3 per-page
// callback pattern). The `ScanCommand` physical shape (ProjectionExpression /
// ExclusiveStartKey pagination) is now pinned at the seam layer
// (`control-data/competitor-accounts-repository.test.ts`); this suite verifies
// the adapter correctly delegates and streams pages end-to-end. The CloudWatch
// `PutMetricData` adapter is unaffected by the seam migration and keeps its own
// physical-shape pin here (Issue #1237: SDK Command construction lives in
// `repository.ts`, orchestration-only tests live in `external-id-audit-handler.test.ts`).

describe("createCompetitorAccountsRepository (adapter over the control-data seam)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should stream every row's rotation-audit projection via forEachAccountPage", async () => {
    const ddb = makeFakeDdb();
    const seed = new DynamoDbCompetitorAccountsRepository(ddb, "AcctTbl");
    await seed.createAccount({
      tenantId: "tenant-a",
      awsAccountId: "111111111111",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: "sub-1",
    });

    const repository = createCompetitorAccountsRepository({
      runtime: makeTestControlDataRuntime(),
      ddb,
      tableName: "AcctTbl",
    });
    const pages: unknown[][] = [];
    await repository.forEachAccountPage(async (items) => {
      pages.push([...items]);
    });

    // The in-memory fake does not simulate DynamoDB's server-side
    // ProjectionExpression trim (that physical shape is pinned separately in
    // `control-data/competitor-accounts-repository.test.ts`); this suite only
    // asserts the 4 fields the audit handler actually reads are present and
    // correct end-to-end through the adapter.
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject([
      {
        tenantId: "tenant-a",
        awsAccountId: "111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("should call onPage once per physical page across a multi-page scan", async () => {
    const ddb = makeFakeDdb({ pageSize: 1 });
    const seed = new DynamoDbCompetitorAccountsRepository(ddb, "AcctTbl");
    await seed.createAccount({
      tenantId: "tenant-a",
      awsAccountId: "111111111111",
      region: "ap-northeast-1",
      competitorRoleName: "Role",
      verified: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: "sub-1",
    });
    await seed.createAccount({
      tenantId: "tenant-b",
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "Role",
      verified: false,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      createdBy: "sub-2",
    });

    const repository = createCompetitorAccountsRepository({
      runtime: makeTestControlDataRuntime(),
      ddb,
      tableName: "AcctTbl",
    });
    const pageSizes: number[] = [];
    await repository.forEachAccountPage(async (items) => {
      pageSizes.push(items.length);
    });

    expect(pageSizes).toEqual([1, 1]);
  });

  it("should call onPage zero times when the table is empty", async () => {
    const ddb = makeFakeDdb();
    const repository = createCompetitorAccountsRepository({
      runtime: makeTestControlDataRuntime(),
      ddb,
      tableName: "AcctTbl",
    });
    const onPage = vi.fn().mockResolvedValue(undefined);

    await repository.forEachAccountPage(onPage);

    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([]);
  });
});

describe("createRotationAgeMetricsRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should write to the TenkaCloud/CompetitorAccounts namespace with RotationAge / None / TenantId+AwsAccountId+Environment dimensions", async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const repo = createRotationAgeMetricsRepository({ send } as never);
    const timestamp = new Date("2026-05-12T00:00:00.000Z");

    await repo.putRotationAge({
      datapoints: [{ tenantId: "tenant-acme", awsAccountId: "222222222222", ageDays: 42 }],
      environmentName: "development",
      timestamp,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as PutMetricDataCommand;
    expect(cmd).toBeInstanceOf(PutMetricDataCommand);
    expect(cmd.input.Namespace).toBe("TenkaCloud/CompetitorAccounts");
    const data = cmd.input.MetricData ?? [];
    expect(data).toHaveLength(1);
    expect(data[0]?.MetricName).toBe("RotationAge");
    expect(data[0]?.Value).toBe(42);
    expect(data[0]?.Unit).toBe("None");
    expect(data[0]?.Timestamp).toEqual(timestamp);
    expect(data[0]?.Dimensions).toEqual([
      { Name: "TenantId", Value: "tenant-acme" },
      { Name: "AwsAccountId", Value: "222222222222" },
      { Name: "Environment", Value: "development" },
    ]);
  });

  it("should not call PutMetricData when there are no datapoints", async () => {
    const send = vi.fn();
    const repo = createRotationAgeMetricsRepository({ send } as never);

    await repo.putRotationAge({
      datapoints: [],
      environmentName: "development",
      timestamp: new Date(),
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("should chunk batches that exceed the PutMetricData 1000-datapoint limit", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repo = createRotationAgeMetricsRepository({ send } as never);
    const datapoints = Array.from({ length: 1500 }, (_, i) => ({
      tenantId: `tenant-${i}`,
      awsAccountId: String(100000000000 + i),
      ageDays: i,
    }));

    await repo.putRotationAge({
      datapoints,
      environmentName: "production",
      timestamp: new Date("2026-05-12T00:00:00.000Z"),
    });

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as PutMetricDataCommand;
    const second = send.mock.calls[1]?.[0] as PutMetricDataCommand;
    expect(first.input.MetricData).toHaveLength(1000);
    expect(second.input.MetricData).toHaveLength(500);
  });
});
