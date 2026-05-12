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
export async function fetchTenantsInsightSummary(
  config: AppConfig,
  idToken: string,
  tenantIds: readonly string[],
): Promise<TenantsInsightSummaryResponse | null> {
  if (!config.adminInsightApiUrl) {
    return null;
  }
  if (tenantIds.length === 0) {
    return { items: [] };
  }
  const base = config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;
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
      // Tenant Admin が token を持ってきた場合 (= cognito:groups に SystemAdmin が無い)。
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
