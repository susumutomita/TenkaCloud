import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditDependencies,
  collectRotationAges,
  computeRotationAgeDays,
  emitRotationAgeMetrics,
  runAudit,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/index";

// Phase 3.2 / Issue #603: ExternalId rotation 監査 Lambda のユニットテスト。
//
// Lambda は CompetitorAccounts DDB を Scan し、`rotatedAt` (= 未 rotate なら `createdAt`) からの
// 経過日数を CloudWatch メトリクスに publish する。pure function (`computeRotationAgeDays`) +
// adapter 経路 (`runAudit`) の 2 層で検証する。

const NOW_MS = Date.parse("2026-05-12T00:00:00.000Z");

function buildDeps(): {
  deps: AuditDependencies;
  ddbSend: ReturnType<typeof vi.fn>;
  cwSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const cwSend = vi.fn();
  const deps: AuditDependencies = {
    ddb: { send: ddbSend } as unknown as AuditDependencies["ddb"],
    cw: { send: cwSend } as unknown as AuditDependencies["cw"],
    tableName: "TestCompetitorAccounts",
    environmentName: "development",
    now: () => NOW_MS,
  };
  return { deps, ddbSend, cwSend };
}

describe("computeRotationAgeDays (pure)", () => {
  it("should return days since rotate when rotatedAt is set", () => {
    // 7 日前 = 7 days ago。
    const sevenDaysAgo = new Date(NOW_MS - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeRotationAgeDays(
        { rotatedAt: sevenDaysAgo, createdAt: "2025-01-01T00:00:00.000Z" },
        NOW_MS,
      ),
    ).toBe(7);
  });

  it("should fall back to days since createdAt when rotatedAt is missing (days since initial issuance)", () => {
    const thirtyDaysAgo = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeRotationAgeDays({ createdAt: thirtyDaysAgo }, NOW_MS)).toBe(30);
  });

  it("should return 0 for rows without rotatedAt or createdAt (safe side, avoid spurious alarms)", () => {
    expect(computeRotationAgeDays({}, NOW_MS)).toBe(0);
  });

  it("should return 0 when rotatedAt is an unparseable string", () => {
    expect(computeRotationAgeDays({ rotatedAt: "not-a-date" }, NOW_MS)).toBe(0);
  });

  it("should return 0 when rotatedAt is in the future (clock skew)", () => {
    const future = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString();
    expect(computeRotationAgeDays({ rotatedAt: future }, NOW_MS)).toBe(0);
  });
});

describe("collectRotationAges", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should convert DDB Scan Items into datapoints", async () => {
    const { deps, ddbSend } = buildDeps();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          tenantId: "tenant-acme",
          awsAccountId: "222222222222",
          rotatedAt: new Date(NOW_MS - 14 * 24 * 60 * 60 * 1000).toISOString(),
          createdAt: "2025-01-01T00:00:00.000Z",
        },
        {
          tenantId: "tenant-beta",
          awsAccountId: "333333333333",
          createdAt: new Date(NOW_MS - 100 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    const datapoints = await collectRotationAges(deps);

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(datapoints).toHaveLength(2);
    expect(datapoints[0]).toEqual({
      tenantId: "tenant-acme",
      awsAccountId: "222222222222",
      ageDays: 14,
    });
    expect(datapoints[1]).toEqual({
      tenantId: "tenant-beta",
      awsAccountId: "333333333333",
      ageDays: 100,
    });
  });

  it("should Scan a second page when LastEvaluatedKey is returned", async () => {
    const { deps, ddbSend } = buildDeps();
    ddbSend
      .mockResolvedValueOnce({
        Items: [
          {
            tenantId: "tenant-1",
            awsAccountId: "111111111111",
            createdAt: new Date(NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
        LastEvaluatedKey: { PK: "TENANT#tenant-1", SK: "ACCOUNT#111111111111" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            tenantId: "tenant-2",
            awsAccountId: "222222222222",
            createdAt: new Date(NOW_MS - 20 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      });

    const datapoints = await collectRotationAges(deps);
    expect(ddbSend).toHaveBeenCalledTimes(2);
    expect(datapoints).toHaveLength(2);
    const secondScan = ddbSend.mock.calls[1]?.[0] as ScanCommand;
    expect(secondScan.input.ExclusiveStartKey).toEqual({
      PK: "TENANT#tenant-1",
      SK: "ACCOUNT#111111111111",
    });
  });

  it("should skip rows missing tenantId / awsAccountId (absorb inconsistent data)", async () => {
    const { deps, ddbSend } = buildDeps();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          tenantId: "tenant-ok",
          awsAccountId: "222222222222",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        { tenantId: "tenant-bad" /* no awsAccountId */ },
        { awsAccountId: "333333333333" /* no tenantId */ },
      ],
    });
    const datapoints = await collectRotationAges(deps);
    expect(datapoints).toHaveLength(1);
    expect(datapoints[0]?.tenantId).toBe("tenant-ok");
  });
});

describe("emitRotationAgeMetrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should write to the TenkaCloud/CompetitorAccounts namespace via PutMetricData", async () => {
    const { deps, cwSend } = buildDeps();
    cwSend.mockResolvedValueOnce({});
    await emitRotationAgeMetrics(deps, [
      { tenantId: "tenant-acme", awsAccountId: "222222222222", ageDays: 42 },
    ]);
    expect(cwSend).toHaveBeenCalledTimes(1);
    const cmd = cwSend.mock.calls[0]?.[0] as PutMetricDataCommand;
    expect(cmd).toBeInstanceOf(PutMetricDataCommand);
    expect(cmd.input.Namespace).toBe("TenkaCloud/CompetitorAccounts");
    const data = cmd.input.MetricData;
    expect(data).toHaveLength(1);
    const datum = data?.[0];
    expect(datum?.MetricName).toBe("RotationAge");
    expect(datum?.Value).toBe(42);
    expect(datum?.Unit).toBe("None");
    expect(datum?.Dimensions).toEqual([
      { Name: "TenantId", Value: "tenant-acme" },
      { Name: "AwsAccountId", Value: "222222222222" },
      { Name: "Environment", Value: "development" },
    ]);
  });

  it("should not call PutMetricData when there are no datapoints", async () => {
    const { deps, cwSend } = buildDeps();
    await emitRotationAgeMetrics(deps, []);
    expect(cwSend).not.toHaveBeenCalled();
  });
});

describe("runAudit (integration)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should call Scan + PutMetricData in order and return the count", async () => {
    const { deps, ddbSend, cwSend } = buildDeps();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          tenantId: "tenant-acme",
          awsAccountId: "222222222222",
          rotatedAt: new Date(NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString(),
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    cwSend.mockResolvedValueOnce({});

    const out = await runAudit(deps);

    expect(out.count).toBe(1);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(cwSend).toHaveBeenCalledTimes(1);
  });
});
