import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * Issue #950: admin-insight Lambda の `/admin/insight/audit` route を叩く
 * read-only client。 既存 `fetchTenantsInsightSummary` と同じ base URL (= adminInsightApiUrl) を使う。
 *
 * `config.adminInsightApiUrl` 未配線なら null を返す (= 「未配線」 alert で誘導)。
 */

export interface AuditItem {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: string;
  readonly actorUsername?: string;
  readonly action: string;
  readonly outcome: string;
  readonly target?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly occurredAt: string;
  readonly extra?: Record<string, unknown>;
}

export interface AuditPage {
  readonly items: readonly AuditItem[];
  readonly nextCursor?: string;
}

export type AuditScope = "tenant" | "system";

export interface AuditListInput {
  scope: AuditScope;
  tenantId?: string;
  limit?: number;
  cursor?: string;
  /** Issue #1292: ISO8601 lower bound (occurredAt >= from)。 */
  from?: string;
  /** Issue #1292: ISO8601 upper bound (occurredAt <= to)。 */
  to?: string;
  /** Issue #1292: principal (sub / username) で完全一致 filter。 */
  principal?: string;
  /** Issue #1292: action 名で完全一致 filter。 */
  action?: string;
}

export interface AuditClient {
  list(input: AuditListInput): Promise<AuditPage>;
  /** Issue #1292: CSV export (= 全 page を辿って Blob で返す)。 */
  exportCsv(input: Omit<AuditListInput, "limit" | "cursor">): Promise<Blob>;
}

export class AuditApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
  ) {
    super(`Audit API ${status}: ${errorCode ?? "unknown_error"}`);
    this.name = "AuditApiError";
  }
}

function applyFilterParams(url: URL, input: Partial<AuditListInput>): void {
  if (input.from) url.searchParams.set("from", input.from);
  if (input.to) url.searchParams.set("to", input.to);
  if (input.principal) url.searchParams.set("principal", input.principal);
  if (input.action) url.searchParams.set("action", input.action);
}

export function createAuditClient(config: AppConfig, idToken: string): AuditClient | null {
  if (!config.adminInsightApiUrl) return null;
  const base = config.adminInsightApiUrl.endsWith("/")
    ? config.adminInsightApiUrl
    : `${config.adminInsightApiUrl}/`;

  const fetchOrThrow = async (url: URL): Promise<Response> => {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
      },
    });
    if (!res.ok) {
      let errorCode: string | undefined;
      try {
        const body = await res.json();
        if (typeof body === "object" && body !== null && "error" in body) {
          errorCode = String((body as { error: unknown }).error);
        }
      } catch {
        /* noop */
      }
      throw new AuditApiError(res.status, errorCode);
    }
    return res;
  };

  return {
    async list(input) {
      const url = new URL("admin/insight/audit", base);
      url.searchParams.set("scope", input.scope);
      if (input.tenantId) url.searchParams.set("tenantId", input.tenantId);
      if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
      if (input.cursor) url.searchParams.set("cursor", input.cursor);
      applyFilterParams(url, input);
      const res = await fetchOrThrow(url);
      return (await res.json()) as AuditPage;
    },
    async exportCsv(input) {
      const url = new URL("admin/insight/audit/export", base);
      url.searchParams.set("scope", input.scope);
      if (input.tenantId) url.searchParams.set("tenantId", input.tenantId);
      applyFilterParams(url, input);
      const res = await fetchOrThrow(url);
      return await res.blob();
    },
  };
}

export function describeAuditError(err: AuditApiError): string {
  switch (err.status) {
    case StatusCodes.FORBIDDEN:
      return "SystemAdmin role が必要です";
    case StatusCodes.SERVICE_UNAVAILABLE:
      return "AdminInsight stack に AdminAuditLog table が配線されていません (= deploy chain の更新が必要)";
    case StatusCodes.BAD_REQUEST:
      if (err.errorCode === "invalid_scope") return "scope が無効です (= tenant / system のみ)";
      if (err.errorCode === "invalid_tenant_id") return "tenantId 形式が無効です";
      return "リクエストが無効です";
    default:
      return `エラーが発生しました (${err.status})`;
  }
}
