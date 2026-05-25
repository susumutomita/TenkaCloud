import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: Control Plane tenants CRUD client。
 * 実 SBT ControlPlane API は `/tenants` (REST), POST/GET/DELETE。
 */

export interface TenantSummary {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly tier?: string;
  readonly status?: string;
  readonly email?: string;
}

export interface CreateTenantInput {
  readonly tenantName: string;
  readonly tier: string;
  readonly email: string;
}

export class TenantsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async list(): Promise<TenantSummary[]> {
    const res = (await fetchWithAuth(this.baseUrl, "/tenants", {}, this.authConfig)) as
      | { data?: TenantSummary[]; tenants?: TenantSummary[] }
      | TenantSummary[]
      | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.tenants ?? [];
  }

  async get(tenantId: string): Promise<TenantSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/tenants/${encodeURIComponent(tenantId)}`,
      {},
      this.authConfig,
    )) as TenantSummary;
  }

  async create(input: CreateTenantInput): Promise<TenantSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      "/tenants",
      { method: "POST", body: input },
      this.authConfig,
    )) as TenantSummary;
  }

  async delete(tenantId: string): Promise<void> {
    await fetchWithAuth(
      this.baseUrl,
      `/tenants/${encodeURIComponent(tenantId)}`,
      { method: "DELETE" },
      this.authConfig,
    );
  }
}
