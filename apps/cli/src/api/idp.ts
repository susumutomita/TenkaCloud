import type { FetchAuthConfig } from "../http/fetch-with-auth.ts";
import { fetchWithAuth } from "../http/fetch-with-auth.ts";

/**
 * Issue #1305: SAML IdP CRUD client (Issues #1293/#1294)。
 * Tenant Admin API: `/idp`。
 */

export interface IdpSummary {
  readonly idpId: string;
  readonly name?: string;
  readonly metadataUrl?: string;
  readonly status?: string;
  readonly updatedAt?: string;
}

export interface CreateIdpInput {
  readonly name: string;
  readonly metadataUrl: string;
}

export interface UpdateIdpInput {
  readonly metadataUrl: string;
}

export class IdpApi {
  constructor(
    private readonly baseUrl: string,
    private readonly authConfig: FetchAuthConfig,
  ) {}

  async list(): Promise<IdpSummary[]> {
    const res = (await fetchWithAuth(this.baseUrl, "/idp", {}, this.authConfig)) as
      | { data?: IdpSummary[]; idps?: IdpSummary[] }
      | IdpSummary[]
      | undefined;
    if (Array.isArray(res)) return res;
    return res?.data ?? res?.idps ?? [];
  }

  async create(input: CreateIdpInput): Promise<IdpSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      "/idp",
      { method: "POST", body: input },
      this.authConfig,
    )) as IdpSummary;
  }

  async update(idpId: string, input: UpdateIdpInput): Promise<IdpSummary> {
    return (await fetchWithAuth(
      this.baseUrl,
      `/idp/${encodeURIComponent(idpId)}`,
      { method: "PATCH", body: input },
      this.authConfig,
    )) as IdpSummary;
  }

  async delete(idpId: string): Promise<void> {
    await fetchWithAuth(
      this.baseUrl,
      `/idp/${encodeURIComponent(idpId)}`,
      { method: "DELETE" },
      this.authConfig,
    );
  }
}
