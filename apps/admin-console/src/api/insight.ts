import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * 1 tenant 分の deploy / event 集計 (ADR-011 #590 Phase 1.A)。
 * backend (`AdminInsightApiLambda`) が返す正本 shape と一致させる。
 */
export interface TenantInsightSummary {
  readonly tenantId: string;
  readonly activeDeploys: number;
  readonly failedDeploys: number;
  /**
   * [Issue #2946] 一度でも COMPLETE に到達した累計。撤去しても 0 に戻らない。
   *
   * optional なのは、この field を返さない旧 backend に対して **0 と偽らない** ため。
   * 未提供は「不明」であって「成功 0 件」ではない (UI は "—" を出す)。
   */
  readonly everCompletedDeploys?: number;
  readonly totalEvents: number;
}

export interface TenantsInsightSummaryResponse {
  readonly items: readonly TenantInsightSummary[];
}

/**
 * AdminInsight API は SBT ControlPlane API と別 origin (= API GW HTTP API) で動く。
 * 既存の `ApiClient` (= ControlPlane API base URL に固定) は使えないので、専用 fetch
 * 関数を用意する。idToken は AuthProvider から caller が渡す。
 *
 * 空 tenant 一覧 (= caller が tenants 0 件のときに呼ぶ) は API 呼び出しを完全に skip して
 * `{ items: [] }` を返す (= Free Tier RCU 圧迫を回避 + 不要 cold start を避ける)。
 *
 * config.adminInsightApiUrl が空文字 (= phase 2 初回 deploy 前 / dev 未配線) なら null
 * を返す。caller (TenantList) は null を見て column を hide する。
 */
/**
 * AdminInsight API の base URL を正規化する (= 末尾 `/` を保証して `new URL(path, base)` の
 * relative 解決を安定させる)。 未配線 (= `adminInsightApiUrl` 空) なら null。 複数 fetch 関数で共有。
 */
function insightApiBase(config: AppConfig): string | null {
  if (!config.adminInsightApiUrl) {
    return null;
  }
  return config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;
}

export async function fetchTenantsInsightSummary(
  config: AppConfig,
  idToken: string,
  tenantIds: readonly string[],
): Promise<TenantsInsightSummaryResponse | null> {
  const base = insightApiBase(config);
  if (!base) {
    return null;
  }
  if (tenantIds.length === 0) {
    return { items: [] };
  }
  // 100 件超は backend 側で 400 を返すため、frontend で先に chunk する余地はあるが、
  // Phase 1.A の MVP scale (~5 tenants) では問題にならない。Phase 3 dashboard で必要なら
  // chunk 化する。
  const url = new URL("admin/insight/tenants/summary", base);
  url.searchParams.set("tenantIds", tenantIds.join(","));
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    if (res.status === StatusCodes.FORBIDDEN) {
      // Tenant Admin が token を持ってきた場合 (= custom:userRole が "SystemAdmin" でない)。
      // 例外を throw すると tenant 一覧本体まで巻き込んで UI が壊れる。null を返して
      // caller が「未表示」扱いにする (= 集計 column 単体だけ static 値 0 を出す)。
      return null;
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`AdminInsight API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as TenantsInsightSummaryResponse;
}

/**
 * `summary.items` を tenantId をキーにした Record に変換する。
 * TenantList が tenants との join で使う (= O(1) lookup)。
 * 同じ tenantId が複数行ある (= backend bug) ケースでは後勝ち。
 */
export function indexSummaryByTenantId(
  summary: TenantsInsightSummaryResponse,
): Record<string, TenantInsightSummary> {
  const out: Record<string, TenantInsightSummary> = {};
  for (const item of summary.items) {
    out[item.tenantId] = item;
  }
  return out;
}

/**
 * #1431: 月次コスト予算の消化サマリ (= admin-insight Lambda `GET /admin/insight/cost`)。
 * backend は AWS Budgets `DescribeBudget` (無料) を読む。 budget / 権限が未配線なら
 * `{ available: false }` を返す (= Cost Explorer は使わない cost-zero 設計)。
 */
export interface CostSummaryAvailable {
  readonly available: true;
  readonly limitUsd: number | null;
  readonly actualSpendUsd: number | null;
  readonly forecastedSpendUsd: number | null;
  readonly percentConsumed: number | null;
  readonly unit: string;
}
export interface CostSummaryUnavailable {
  readonly available: false;
}
export type CostSummaryResponse = CostSummaryAvailable | CostSummaryUnavailable;

/**
 * 月次コスト予算の消化サマリを取得する。 `adminInsightApiUrl` 未配線、 または SystemAdmin
 * でない (= 403) なら null を返し、 caller は panel を「未配線」(= 外部リンクのみ) 表示にする。
 */
export async function fetchCostSummary(
  config: AppConfig,
  idToken: string,
): Promise<CostSummaryResponse | null> {
  const base = insightApiBase(config);
  if (!base) {
    return null;
  }
  const url = new URL("admin/insight/cost", base);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    if (res.status === StatusCodes.FORBIDDEN) {
      return null;
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`AdminInsight API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as CostSummaryResponse;
}
