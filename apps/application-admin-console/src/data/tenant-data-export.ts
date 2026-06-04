import type { ApiClient } from "../api/client";
import { listCompetitorAccounts } from "../api/competitor-accounts-client";
import { listAllDeployments } from "../api/deploy-client";
import { listEvents } from "../api/events-client";

/**
 * Issue #1697 (audit 9, データ主体の権利): 自テナント配下の主要データを 1 操作で JSON に
 * 集約し、 ブラウザからダウンロードさせる。 新規 backend / IAM を増やさず、 既存の
 * **テナント scope 済** API (events / deployments / competitor accounts) を再利用して
 * client 側で束ねる (= cross-tenant に触れない既存 isolation をそのまま継承)。
 *
 * 監査ログは別途 Audit Log ページに専用の CSV export があるため本 JSON には含めず、
 * `auditLog` フィールドにその旨を記す (= データ category として漏らさない明示)。
 */
export const TENANT_EXPORT_SCHEMA_VERSION = 1;

export interface TenantDataExport {
  schemaVersion: number;
  tenantId: string | null;
  tenantName: string | null;
  exportedAt: string;
  events: readonly unknown[];
  deployments: readonly unknown[];
  competitorAccounts: readonly unknown[];
  /** 監査ログは Audit Log ページの CSV export を参照 (本 JSON には含めない)。 */
  auditLog: "see CSV export on the Audit Log page";
}

export interface TenantExportMeta {
  tenantId: string | null;
  tenantName: string | null;
  exportedAt: string;
}

const PAGE_LIMIT = 200;

/**
 * cursor ページングを最後まで辿り、 全件を 1 配列に集める。 silent truncation を避ける
 * ため、 nextCursor が無くなるまでループする (= 「全データ」を謳う export の正直さ)。
 */
async function collectAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * 自テナントの events / deployments / competitor accounts を全件取得し、 メタ情報を付けて
 * 1 つの export object にまとめる。
 */
export async function collectTenantDataExport(
  api: ApiClient,
  meta: TenantExportMeta,
): Promise<TenantDataExport> {
  const [events, deployments, competitorAccountsResponse] = await Promise.all([
    collectAllPages((cursor) => listEvents(api, { limit: PAGE_LIMIT, cursor })),
    collectAllPages((cursor) => listAllDeployments(api, { limit: PAGE_LIMIT, cursor })),
    listCompetitorAccounts(api),
  ]);
  return {
    schemaVersion: TENANT_EXPORT_SCHEMA_VERSION,
    tenantId: meta.tenantId,
    tenantName: meta.tenantName,
    exportedAt: meta.exportedAt,
    events,
    deployments,
    competitorAccounts: competitorAccountsResponse.items,
    auditLog: "see CSV export on the Audit Log page",
  };
}

/**
 * JSON を Blob 化してダウンロードさせる。 AuditLog.tsx の CSV download と同じ機構
 * (createObjectURL → anchor click → revoke)。 `doc` は test から差し替え可能。
 */
export function downloadJson(filename: string, data: unknown, doc: Document = document): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** export ファイル名。 tenantId と ISO 日時 (`:`/`.` を `-` に正規化) で一意化する。 */
export function buildTenantExportFilename(tenantId: string | null, exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, "-");
  return `tenant-data-${tenantId ?? "unknown"}-${stamp}.json`;
}
