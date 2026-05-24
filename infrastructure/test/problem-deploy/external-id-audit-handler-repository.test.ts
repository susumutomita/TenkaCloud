import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompetitorAccountsRepository,
  createRotationAgeMetricsRepository,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/repository";

// Issue #1237: SDK Command construction lives in `repository.ts`. These tests
// pin the physical shape of the AWS API calls (Namespace / MetricName / Unit /
// Dimensions / ProjectionExpression) that downstream CloudWatch alarms +
// dashboards depend on — the handler tests now only check orchestration.

describe("createCompetitorAccountsRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should issue a ScanCommand with the rotation projection and propagate items", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Items: [{ tenantId: "tenant-a", awsAccountId: "111111111111", createdAt: "2026-01-01" }],
    });
    const repo = createCompetitorAccountsRepository({ send } as never);

    const page = await repo.scanPage({ tableName: "AcctTbl" });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as ScanCommand;
    expect(cmd).toBeInstanceOf(ScanCommand);
    expect(cmd.input.TableName).toBe("AcctTbl");
    expect(cmd.input.ProjectionExpression).toBe("tenantId, awsAccountId, rotatedAt, createdAt");
    expect(cmd.input.ExclusiveStartKey).toBeUndefined();
    expect(page.items).toEqual([
      { tenantId: "tenant-a", awsAccountId: "111111111111", createdAt: "2026-01-01" },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("should forward the cursor to DDB as ExclusiveStartKey and surface LastEvaluatedKey", async () => {
    const cursor = { PK: "TENANT#a", SK: "ACCOUNT#1" };
    const next = { PK: "TENANT#b", SK: "ACCOUNT#2" };
    const send = vi.fn().mockResolvedValueOnce({ Items: [], LastEvaluatedKey: next });
    const repo = createCompetitorAccountsRepository({ send } as never);

    const page = await repo.scanPage({ tableName: "AcctTbl", cursor });

    const cmd = send.mock.calls[0]?.[0] as ScanCommand;
    expect(cmd.input.ExclusiveStartKey).toEqual(cursor);
    expect(page.nextCursor).toEqual(next);
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
