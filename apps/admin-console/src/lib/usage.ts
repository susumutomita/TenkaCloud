import type { TenantInsightSummary } from "../api/insight";
import type { Tenant } from "../api/tenants";

/**
 * Issue #1767: Usage dashboard の集計ロジック。既存 API (Control Plane の tenant 一覧 +
 * AdminInsight の per-tenant deploy 集計) のみから導出する pure function 群で、 UI
 * (pages/Usage.tsx) から独立して unit test できるようにする。
 *
 * `insight` 引数の規約 (= TenantList の insightByTenantId と同じ):
 *   - `Record<tenantId, TenantInsightSummary>` = 取得済み。 map に居ない tenant は 0 件扱い
 *   - `null` = 未取得 (API 未配線 / 403 / fetch 失敗)。 deploy 系の値は null (= UI は "—" 表示)
 */

/** 集計カード 4 枚分の値。 deploy 合計は insight 未取得時 null。 */
export interface UsageTotals {
  readonly totalTenants: number;
  readonly activeTenants: number;
  readonly totalActiveDeploys: number | null;
  readonly totalFailedDeploys: number | null;
}

/** tier 1 つ分の分布。 percentage は全 tenant に対する整数 % (四捨五入)。 */
export interface TierCount {
  readonly tier: string;
  readonly count: number;
  readonly percentage: number;
}

/** per-tenant table の 1 行。 deploy 数は insight 未取得時 null (= "—" 表示)。 */
export interface UsageRow {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tier: string;
  readonly tenantStatus: string;
  readonly activeDeploys: number | null;
  /**
   * status === "COMPLETE" の件数。 null になる 2 経路があり、 どちらも UI は "—" を出す:
   *   - insight 自体が未取得 (他の deploy 列と同じ)
   *   - insight は取得できたが backend が本 field を返さない (= Lambda がまだ旧版)
   * 後者を 0 に潰さないのが重要 ([[TenantInsightSummary.completedDeploys]] のコメント参照)。
   */
  readonly completedDeploys: number | null;
  readonly failedDeploys: number | null;
  /**
   * [Issue #2946] 一度でも成功した deploy の累計。撤去しても 0 に戻らないので、「健全に
   * 回しているテナント」と「一度も deploy していないテナント」を撤去後も区別できる。
   *
   * `null` は **不明** (insight 未取得、または field を返さない旧 backend) であって
   * 「成功 0 件」ではない。両者を同じ 0 として描かない。
   */
  readonly everCompletedDeploys: number | null;
}

/** table の sort 対象 field (UsageRow の column keys)。 */
export type UsageSortField =
  | "tenantName"
  | "tier"
  | "tenantStatus"
  | "activeDeploys"
  | "completedDeploys"
  | "failedDeploys"
  | "everCompletedDeploys";

/**
 * deprovision 済み tenant の判定 (TenantList page の表示規約と同一):
 *   - tenantStatus が "Deleted" / "Deprovisioned" (case-insensitive)
 *   - または isActive === false (SBT v0.3.9 の DELETE /tenants は isActive=false にする)
 */
export function isDeprovisionedTenant(t: Pick<Tenant, "tenantStatus" | "isActive">): boolean {
  const status = (t.tenantStatus ?? "").toLowerCase();
  if (status === "deleted" || status === "deprovisioned") return true;
  return t.isActive === false;
}

/** 集計カード: 全 tenant 数 / active tenant 数 / active・failed deploy 合計。 */
export function computeUsageTotals(
  tenants: readonly Tenant[],
  insight: Readonly<Record<string, TenantInsightSummary>> | null,
): UsageTotals {
  const activeTenants = tenants.filter((t) => !isDeprovisionedTenant(t)).length;
  if (insight === null && tenants.length > 0) {
    return {
      totalTenants: tenants.length,
      activeTenants,
      totalActiveDeploys: null,
      totalFailedDeploys: null,
    };
  }
  let totalActiveDeploys = 0;
  let totalFailedDeploys = 0;
  for (const tenant of tenants) {
    const summary = insight?.[tenant.tenantId];
    totalActiveDeploys += summary?.activeDeploys ?? 0;
    totalFailedDeploys += summary?.failedDeploys ?? 0;
  }
  return { totalTenants: tenants.length, activeTenants, totalActiveDeploys, totalFailedDeploys };
}

/**
 * tier 分布。 tier 文字列は経路によって case が揺れる ("PLATINUM" / "platinum") ので
 * 小文字へ正規化して group し、 未設定は "unknown" に寄せる。 count 降順 → tier 名昇順。
 */
export function computeTierDistribution(tenants: readonly Tenant[]): readonly TierCount[] {
  const counts = new Map<string, number>();
  for (const tenant of tenants) {
    const tier = (tenant.tier ?? "").toLowerCase() || "unknown";
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tier, count]) => ({
      tier,
      count,
      percentage: Math.round((count / tenants.length) * 100),
    }))
    .sort((a, b) => b.count - a.count || a.tier.localeCompare(b.tier));
}

/**
 * 完了件数だけは「map に居ない tenant」と「item にこの field が無い backend」を区別する。
 *   - summary 無し (= 取得済みだが対象 tenant の行が無い) → 0 件が正しい
 *   - summary 有り + field 無し (= admin-insight Lambda が旧版) → 不明。 0 と言ってはいけない
 */
function completedFromSummary(summary: TenantInsightSummary | undefined): number | null {
  if (!summary) return 0;
  return summary.completedDeploys ?? null;
}

/** tenant 一覧と insight 集計を tenantId で join して table 行を作る。 */
export function buildUsageRows(
  tenants: readonly Tenant[],
  insight: Readonly<Record<string, TenantInsightSummary>> | null,
): readonly UsageRow[] {
  return tenants.map((tenant) => {
    const summary = insight?.[tenant.tenantId];
    return {
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      tier: tenant.tier,
      tenantStatus: tenant.tenantStatus,
      activeDeploys: insight === null ? null : (summary?.activeDeploys ?? 0),
      completedDeploys: insight === null ? null : completedFromSummary(summary),
      failedDeploys: insight === null ? null : (summary?.failedDeploys ?? 0),
      // `?? 0` を使わない: field 不在は「不明」で、0 件成功とは違う (#2946)。
      everCompletedDeploys: insight === null ? null : (summary?.everCompletedDeploys ?? null),
    };
  });
}

/**
 * table の sort。 数値 field は null (= insight 未取得) を 0 として扱い、 文字列 field は
 * localeCompare。 入力配列は破壊しない (= React state をそのまま渡せる)。
 */
export function sortUsageRows(
  rows: readonly UsageRow[],
  field: UsageSortField,
  descending: boolean,
): readonly UsageRow[] {
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    const cmp =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : Number(left ?? 0) - Number(right ?? 0);
    return cmp * direction;
  });
}
