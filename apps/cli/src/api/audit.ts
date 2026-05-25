import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: Audit log query / export client (Issue #1292)。
 * Tenant Admin API: `/audit`。
 */

export interface AuditEntry {
  readonly timestamp: string;
  readonly principal: string;
  readonly action: string;
  readonly resource?: string;
  readonly outcome?: string;
  readonly source?: string;
}

export interface AuditQuery {
  readonly from?: string;
  readonly to?: string;
  readonly principal?: string;
  readonly action?: string;
}

export class AuditApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async query(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const res = (await fetchWithAuth(
      this.baseUrl,
      "/audit",
      {
        query: {
          from: query.from,
          to: query.to,
          principal: query.principal,
          action: query.action,
        },
      },
      this.authConfig,
    )) as { data?: AuditEntry[]; entries?: AuditEntry[] } | AuditEntry[] | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.entries ?? [];
  }
}
