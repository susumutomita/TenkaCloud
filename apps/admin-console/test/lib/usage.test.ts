import { describe, expect, it } from "vitest";
import type { TenantInsightSummary } from "../../src/api/insight";
import type { Tenant } from "../../src/api/tenants";
import {
  buildUsageRows,
  computeTierDistribution,
  computeUsageTotals,
  isDeprovisionedTenant,
  sortUsageRows,
  type UsageRow,
} from "../../src/lib/usage";

/**
 * Issue #1767: Usage dashboard の集計 (合計カード / tier 分布 / per-tenant join / sort) を
 * pure function として検証する。UI へは UsagePage (test/Usage.test.tsx) 側で結線を確認する。
 */

const tenant = (over: Partial<Tenant>): Tenant => ({
  tenantId: "t-x",
  tenantName: "X Org",
  email: "x@example.test",
  tier: "basic",
  tenantStatus: "Complete",
  isActive: true,
  ...over,
});

const insightItem = (over: Partial<TenantInsightSummary>): TenantInsightSummary => ({
  tenantId: "t-x",
  activeDeploys: 0,
  completedDeploys: 0,
  failedDeploys: 0,
  totalEvents: 0,
  ...over,
});

// provision-tenant.sh は tier を大文字 ("PLATINUM") で比較する経路があり、 API の生データも
// case が揺れる。 型上は lowercase union だが、 揺れ耐性を検証するため cast で混在させる。
const upperPlatinum = "PLATINUM" as Tenant["tier"];

const tenants: Tenant[] = [
  tenant({ tenantId: "t-a", tenantName: "Alpha Org", tier: "basic" }),
  tenant({ tenantId: "t-b", tenantName: "Beta Org", tier: upperPlatinum }),
  tenant({
    tenantId: "t-c",
    tenantName: "Gamma Org",
    tier: "basic",
    tenantStatus: "Deleted",
    isActive: false,
  }),
];

const insight: Record<string, TenantInsightSummary> = {
  "t-a": insightItem({
    tenantId: "t-a",
    activeDeploys: 2,
    completedDeploys: 4,
    failedDeploys: 1,
    everCompletedDeploys: 7,
  }),
  // [Issue #2946] everCompletedDeploys を返さない旧 backend の応答。0 と偽らず null になる。
  "t-b": insightItem({ tenantId: "t-b", activeDeploys: 3, completedDeploys: 1, failedDeploys: 0 }),
};

describe("isDeprovisionedTenant", () => {
  it("should treat Deleted / Deprovisioned statuses as deprovisioned case-insensitively", () => {
    expect(isDeprovisionedTenant(tenant({ tenantStatus: "Deleted" }))).toBe(true);
    expect(isDeprovisionedTenant(tenant({ tenantStatus: "DEPROVISIONED" }))).toBe(true);
    expect(isDeprovisionedTenant(tenant({ tenantStatus: "Complete" }))).toBe(false);
  });

  it("should treat isActive=false as deprovisioned even when the status looks active", () => {
    expect(isDeprovisionedTenant(tenant({ tenantStatus: "Complete", isActive: false }))).toBe(true);
  });

  it("should keep tenants with an undefined status active", () => {
    expect(isDeprovisionedTenant(tenant({ tenantStatus: undefined as unknown as string }))).toBe(
      false,
    );
  });
});

describe("computeUsageTotals", () => {
  it("should count total and active tenants and sum active/failed deploys", () => {
    expect(computeUsageTotals(tenants, insight)).toEqual({
      totalTenants: 3,
      activeTenants: 2,
      totalActiveDeploys: 5,
      totalFailedDeploys: 1,
    });
  });

  it("should treat tenants missing from the insight summary as zero deploys", () => {
    const partial = { "t-a": insightItem({ tenantId: "t-a", activeDeploys: 4, failedDeploys: 2 }) };
    expect(computeUsageTotals(tenants, partial)).toEqual({
      totalTenants: 3,
      activeTenants: 2,
      totalActiveDeploys: 4,
      totalFailedDeploys: 2,
    });
  });

  it("should return null deploy totals when the insight summary is unavailable", () => {
    expect(computeUsageTotals(tenants, null)).toEqual({
      totalTenants: 3,
      activeTenants: 2,
      totalActiveDeploys: null,
      totalFailedDeploys: null,
    });
  });

  it("should return zeros for an empty tenant list", () => {
    expect(computeUsageTotals([], insight)).toEqual({
      totalTenants: 0,
      activeTenants: 0,
      totalActiveDeploys: 0,
      totalFailedDeploys: 0,
    });
  });
});

describe("computeTierDistribution", () => {
  it("should group tiers case-insensitively and compute counts with percentages", () => {
    expect(computeTierDistribution(tenants)).toEqual([
      { tier: "basic", count: 2, percentage: 67 },
      { tier: "platinum", count: 1, percentage: 33 },
    ]);
  });

  it("should sort by count descending and break ties by tier name", () => {
    const even = [
      tenant({ tenantId: "1", tier: upperPlatinum }),
      tenant({ tenantId: "2", tier: "basic" }),
      tenant({ tenantId: "3", tier: "platinum" }),
      tenant({ tenantId: "4", tier: "basic" }),
    ];
    expect(computeTierDistribution(even).map((d) => d.tier)).toEqual(["basic", "platinum"]);
  });

  it("should label a missing tier as unknown", () => {
    const noTier = [tenant({ tenantId: "1", tier: undefined as unknown as Tenant["tier"] })];
    expect(computeTierDistribution(noTier)).toEqual([
      { tier: "unknown", count: 1, percentage: 100 },
    ]);
  });

  it("should return an empty distribution for no tenants", () => {
    expect(computeTierDistribution([])).toEqual([]);
  });
});

describe("buildUsageRows", () => {
  it("should join tenants with insight counts and default absent tenants to zero", () => {
    expect(buildUsageRows(tenants, insight)).toEqual([
      {
        tenantId: "t-a",
        tenantName: "Alpha Org",
        tier: "basic",
        tenantStatus: "Complete",
        activeDeploys: 2,
        completedDeploys: 4,
        failedDeploys: 1,
        everCompletedDeploys: 7,
      },
      {
        tenantId: "t-b",
        tenantName: "Beta Org",
        tier: "PLATINUM",
        tenantStatus: "Complete",
        activeDeploys: 3,
        completedDeploys: 1,
        failedDeploys: 0,
        everCompletedDeploys: null,
      },
      {
        tenantId: "t-c",
        tenantName: "Gamma Org",
        tier: "basic",
        tenantStatus: "Deleted",
        activeDeploys: 0,
        completedDeploys: 0,
        failedDeploys: 0,
        everCompletedDeploys: null,
      },
    ]);
  });

  it("should carry null deploy counts when the insight summary is unavailable", () => {
    const rows = buildUsageRows(tenants, null);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.activeDeploys).toBeNull();
      expect(row.completedDeploys).toBeNull();
      expect(row.failedDeploys).toBeNull();
      expect(row.everCompletedDeploys).toBeNull();
    }
  });

  // deploy skew: admin-insight Lambda が旧版で completedDeploys を返さない環境。 0 に潰すと
  // 「成功しているのに 0」= この列が直そうとしている誤読そのものになるので null (= "—") にする。
  it("should keep completedDeploys null when the backend does not report the field", () => {
    const legacy: Record<string, TenantInsightSummary> = {
      "t-a": { tenantId: "t-a", activeDeploys: 1, failedDeploys: 0, totalEvents: 0 },
    };
    const rows = buildUsageRows(tenants, legacy);
    expect(rows[0]).toMatchObject({ activeDeploys: 1, completedDeploys: null });
    // 一方、 取得済みで対象 tenant の行が無い場合は 0 件が正しい (未報告ではない)。
    expect(rows[1]).toMatchObject({ activeDeploys: 0, completedDeploys: 0 });
  });
});

describe("sortUsageRows", () => {
  const rows: readonly UsageRow[] = buildUsageRows(tenants, insight);

  it("should sort numerically by activeDeploys in both directions", () => {
    expect(sortUsageRows(rows, "activeDeploys", true).map((r) => r.tenantId)).toEqual([
      "t-b",
      "t-a",
      "t-c",
    ]);
    expect(sortUsageRows(rows, "activeDeploys", false).map((r) => r.tenantId)).toEqual([
      "t-c",
      "t-a",
      "t-b",
    ]);
  });

  it("should sort alphabetically by tenantName", () => {
    expect(sortUsageRows(rows, "tenantName", false).map((r) => r.tenantName)).toEqual([
      "Alpha Org",
      "Beta Org",
      "Gamma Org",
    ]);
    expect(sortUsageRows(rows, "tenantName", true).map((r) => r.tenantName)).toEqual([
      "Gamma Org",
      "Beta Org",
      "Alpha Org",
    ]);
  });

  it("should sort numerically by completedDeploys in both directions", () => {
    // completedDeploys: t-a=4, t-b=1, t-c=0 (insight に居ない)
    expect(sortUsageRows(rows, "completedDeploys", true).map((r) => r.tenantId)).toEqual([
      "t-a",
      "t-b",
      "t-c",
    ]);
    expect(sortUsageRows(rows, "completedDeploys", false).map((r) => r.tenantId)).toEqual([
      "t-c",
      "t-b",
      "t-a",
    ]);
  });

  it("should treat null deploy counts as zero when sorting", () => {
    const nullRows = buildUsageRows(tenants, null);
    expect(sortUsageRows(nullRows, "failedDeploys", true).map((r) => r.tenantId)).toEqual([
      "t-a",
      "t-b",
      "t-c",
    ]);
  });

  it("should not mutate the input array", () => {
    const before = rows.map((r) => r.tenantId);
    sortUsageRows(rows, "activeDeploys", true);
    expect(rows.map((r) => r.tenantId)).toEqual(before);
  });
});

/**
 * [Issue #2946] 撤去後に「健全なテナント」と「何もしていないテナント」を区別する列。
 *
 * 現在値の 2 列は撤去で揃って 0 になるため、この列だけがその区別を担う。「不明」を 0 と
 * 描かないことが要件そのもの (旧 backend の応答と、本当に 0 件のテナントは違う)。
 */
describe("everCompletedDeploys (#2946)", () => {
  it("should keep a non-zero cumulative count for a tenant whose deployments were all torn down", () => {
    const tornDown: Record<string, TenantInsightSummary> = {
      "t-a": insightItem({
        tenantId: "t-a",
        activeDeploys: 0,
        failedDeploys: 0,
        everCompletedDeploys: 4,
      }),
    };
    const row = buildUsageRows(tenants, tornDown)[0];
    expect(row?.activeDeploys).toBe(0);
    expect(row?.failedDeploys).toBe(0);
    expect(row?.everCompletedDeploys).toBe(4);
  });

  it("should distinguish a backend that omits the field from a tenant that genuinely has zero", () => {
    const mixed: Record<string, TenantInsightSummary> = {
      "t-a": insightItem({ tenantId: "t-a", everCompletedDeploys: 0 }),
      "t-b": insightItem({ tenantId: "t-b" }),
    };
    const rows = buildUsageRows(tenants, mixed);
    expect(rows[0]?.everCompletedDeploys).toBe(0);
    expect(rows[1]?.everCompletedDeploys).toBeNull();
  });

  it("should sort by the cumulative column, treating unknown as zero only for ordering", () => {
    const mixed: Record<string, TenantInsightSummary> = {
      "t-a": insightItem({ tenantId: "t-a", everCompletedDeploys: 1 }),
      "t-b": insightItem({ tenantId: "t-b", everCompletedDeploys: 5 }),
    };
    const sorted = sortUsageRows(buildUsageRows(tenants, mixed), "everCompletedDeploys", true);
    expect(sorted.map((row) => row.tenantId)).toEqual(["t-b", "t-a", "t-c"]);
  });
});
