import { StatusCodes } from "http-status-codes";
import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * Issue #1292: Tenant Admin Console (= App Plane) から自テナント audit log を読む client。
 * Event API (= apiBaseUrl) の `/admin/audit-log` / `/admin/audit-log/export` を叩く。
 *
 * 越境防止: backend が JWT claim 由来 tenantId を partition key に固定するので、 client
 * は tenantId を渡さない (= 渡しても無視される)。 UI 側でも tenantId 入力欄を出さない。
 */

export interface TenantAuditItem {
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

export interface TenantAuditPage {
  readonly items: readonly TenantAuditItem[];
  readonly nextCursor?: string;
}

export interface TenantAuditListInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly from?: string;
  readonly to?: string;
  readonly principal?: string;
  readonly action?: string;
}

export class TenantAuditApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
  ) {
    super(`TenantAudit API ${status}: ${errorCode ?? "unknown_error"}`);
    this.name = "TenantAuditApiError";
  }
}

export interface TenantAuditClient {
  list(input: TenantAuditListInput): Promise<TenantAuditPage>;
  /** CSV を Blob で返す (= UI 側で a[download] に渡す)。 */
  exportCsv(input: Omit<TenantAuditListInput, "limit" | "cursor">): Promise<Blob>;
}

export function buildTenantAuditQuery(input: TenantAuditListInput): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.principal) params.set("principal", input.principal);
  if (input.action) params.set("action", input.action);
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

export function createTenantAuditClient(config: AppConfig, idToken: string): TenantAuditClient {
  const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;

  const request = async (path: string): Promise<Response> => {
    const url = new URL(path.replace(/^\//, ""), base);
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
      throw new TenantAuditApiError(res.status, errorCode);
    }
    return res;
  };

  return {
    async list(input) {
      const qs = buildTenantAuditQuery(input);
      const res = await request(`admin/audit-log${qs}`);
      return (await res.json()) as TenantAuditPage;
    },
    async exportCsv(input) {
      const qs = buildTenantAuditQuery(input);
      const res = await request(`admin/audit-log/export${qs}`);
      return await res.blob();
    },
  };
}

export function useTenantAuditClient(config: AppConfig): TenantAuditClient | null {
  const auth = useAuth();
  return useMemo(
    () => (auth.tokens ? createTenantAuditClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );
}

export function describeTenantAuditError(err: TenantAuditApiError): string {
  switch (err.status) {
    case StatusCodes.FORBIDDEN:
      return "TenantAdmin role が必要です";
    case StatusCodes.SERVICE_UNAVAILABLE:
      return "audit log table が配線されていません (= deploy chain の更新が必要)";
    case StatusCodes.BAD_REQUEST:
      if (err.errorCode === "invalid_from") return "from が無効な timestamp です";
      if (err.errorCode === "invalid_to") return "to が無効な timestamp です";
      if (err.errorCode === "invalid_limit") return "limit が無効です";
      return "リクエストが無効です";
    case StatusCodes.UNAUTHORIZED:
      return "セッションが切れました。再ログインしてください";
    default:
      return `エラーが発生しました (${err.status})`;
  }
}
