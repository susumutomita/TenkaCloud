import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuditDependencies,
  collectRotationAges,
  computeRotationAgeDays,
  emitRotationAgeMetrics,
  runAudit,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/index";
import type {
  CompetitorAccountsRepository,
  Repositories,
  RotationAgeMetricsRepository,
} from "../../lib/problem-deploy/handlers/external-id-audit-handler/repository";

// Phase 3.2 / Issue #603: ExternalId rotation 監査 Lambda のユニットテスト。
//
// Lambda は CompetitorAccounts を全件走査し、`rotatedAt` (= 未 rotate なら `createdAt`) からの
// 経過日数を CloudWatch メトリクスに publish する。pure function (`computeRotationAgeDays`) +
// adapter 経路 (`runAudit`) の 2 層で検証する。
//
// [Issue #2442 / Phase C2] `CompetitorAccounts` の読み取りは control-data repository seam
// 経由になり、`forEachAccountPage` (B3 の per-page callback パターン) を 1 度呼ぶだけで全
// ページを走査する (= 旧 `scanPage` cursor ループは廃止)。本テストは callback を複数回呼んで
// multi-page drain をシミュレートする。
//
// Issue #1237: index.ts は repository 越しに SDK を呼ぶ。本テストは「handler の orchestration」
// だけを検証し、SDK Command の物理形 (= ScanCommand / PutMetricDataCommand) の検証は
// `external-id-audit-handler-repository.test.ts` に分離している。

const NOW_MS = Date.parse("2026-05-12T00:00:00.000Z");

interface BuiltDeps {
  readonly deps: AuditDependencies;
  readonly forEachAccountPage: ReturnType<typeof vi.fn>;
  readonly putRotationAge: ReturnType<typeof vi.fn>;
}

function buildDeps(): BuiltDeps {
  const forEachAccountPage = vi.fn();
  const putRotationAge = vi.fn().mockResolvedValue(undefined);
  const competitorAccounts: CompetitorAccountsRepository = { forEachAccountPage };
  const rotationAgeMetrics: RotationAgeMetricsRepository = { putRotationAge };
  const repositories: Repositories = { competitorAccounts, rotationAgeMetrics };
  const deps: AuditDependencies = {
    repositories,
    environmentName: "development",
    now: () => NOW_MS,
  };
  return { deps, forEachAccountPage, putRotationAge };
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

  it("should convert repository page items into datapoints", async () => {
    const { deps, forEachAccountPage } = buildDeps();
    forEachAccountPage.mockImplementationOnce(
      async (onPage: (items: unknown[]) => Promise<void>) => {
        await onPage([
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
        ]);
      },
    );

    const datapoints = await collectRotationAges(deps);

    expect(forEachAccountPage).toHaveBeenCalledTimes(1);
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

  it("should accumulate datapoints across multiple pages (B3 per-page callback)", async () => {
    const { deps, forEachAccountPage } = buildDeps();
    forEachAccountPage.mockImplementationOnce(
      async (onPage: (items: unknown[]) => Promise<void>) => {
        await onPage([
          {
            tenantId: "tenant-1",
            awsAccountId: "111111111111",
            createdAt: new Date(NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ]);
        await onPage([
          {
            tenantId: "tenant-2",
            awsAccountId: "222222222222",
            createdAt: new Date(NOW_MS - 20 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ]);
      },
    );

    const datapoints = await collectRotationAges(deps);
    expect(forEachAccountPage).toHaveBeenCalledTimes(1);
    expect(datapoints).toHaveLength(2);
    expect(datapoints.map((d) => d.tenantId)).toEqual(["tenant-1", "tenant-2"]);
  });

  it("should skip rows missing tenantId / awsAccountId (absorb inconsistent data)", async () => {
    const { deps, forEachAccountPage } = buildDeps();
    forEachAccountPage.mockImplementationOnce(
      async (onPage: (items: unknown[]) => Promise<void>) => {
        await onPage([
          {
            tenantId: "tenant-ok",
            awsAccountId: "222222222222",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
          { tenantId: "tenant-bad" /* no awsAccountId */ },
          { awsAccountId: "333333333333" /* no tenantId */ },
        ]);
      },
    );
    const datapoints = await collectRotationAges(deps);
    expect(datapoints).toHaveLength(1);
    expect(datapoints[0]?.tenantId).toBe("tenant-ok");
  });

  it("should return an empty array when the table has no rows", async () => {
    const { deps, forEachAccountPage } = buildDeps();
    forEachAccountPage.mockImplementationOnce(
      async (onPage: (items: unknown[]) => Promise<void>) => {
        await onPage([]);
      },
    );

    expect(await collectRotationAges(deps)).toEqual([]);
  });
});

describe("emitRotationAgeMetrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should hand datapoints + environment + timestamp to the metrics repository", async () => {
    const { deps, putRotationAge } = buildDeps();
    await emitRotationAgeMetrics(deps, [
      { tenantId: "tenant-acme", awsAccountId: "222222222222", ageDays: 42 },
    ]);
    expect(putRotationAge).toHaveBeenCalledTimes(1);
    const call = putRotationAge.mock.calls[0]?.[0];
    expect(call.environmentName).toBe("development");
    expect(call.timestamp).toEqual(new Date(NOW_MS));
    expect(call.datapoints).toEqual([
      { tenantId: "tenant-acme", awsAccountId: "222222222222", ageDays: 42 },
    ]);
  });

  it("should still call the repository when there are no datapoints (repo decides skip semantics)", async () => {
    const { deps, putRotationAge } = buildDeps();
    await emitRotationAgeMetrics(deps, []);
    expect(putRotationAge).toHaveBeenCalledTimes(1);
    expect(putRotationAge.mock.calls[0]?.[0].datapoints).toEqual([]);
  });
});

describe("runAudit (integration)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should drive the page scan via the repository and publish via the metrics repository, returning the count", async () => {
    const { deps, forEachAccountPage, putRotationAge } = buildDeps();
    forEachAccountPage.mockImplementationOnce(
      async (onPage: (items: unknown[]) => Promise<void>) => {
        await onPage([
          {
            tenantId: "tenant-acme",
            awsAccountId: "222222222222",
            rotatedAt: new Date(NOW_MS - 5 * 24 * 60 * 60 * 1000).toISOString(),
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ]);
      },
    );

    const out = await runAudit(deps);

    expect(out.count).toBe(1);
    expect(forEachAccountPage).toHaveBeenCalledTimes(1);
    expect(putRotationAge).toHaveBeenCalledTimes(1);
    expect(putRotationAge.mock.calls[0]?.[0].datapoints).toEqual([
      { tenantId: "tenant-acme", awsAccountId: "222222222222", ageDays: 5 },
    ]);
  });
});
