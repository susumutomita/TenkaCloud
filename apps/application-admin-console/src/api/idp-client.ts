import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * Tenant-scoped SAML IdP CRUD API client (Issue #1294).
 *
 * Talks to the per-tenant Application Plane IdP Lambda. The tenant is bound by
 * the caller's JWT `custom:tenantId` claim on the server side — the client
 * never sends a tenantId in the body / path.
 *
 * Pooled vs silo:
 *   - SAML SSO is only meaningful on a silo UserPool (= per-tenant pool). On
 *     pooled tiers we hide the UI entirely (see `config.isolation`).
 */

export type PlatformRole = "SystemAdmin" | "TenantAdmin" | "Operator" | "Viewer";

export interface TenantIdpSummary {
  readonly idpId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantIdpDetail extends TenantIdpSummary {
  readonly metadataXml: string;
  readonly attributeMapping: {
    readonly email: string;
    readonly displayName?: string;
    readonly groups?: string;
  };
  readonly groupToRole: Readonly<Record<string, PlatformRole>>;
}

export interface CreateTenantIdpInput {
  readonly idpId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly metadataXml: string;
  readonly attributeMapping: TenantIdpDetail["attributeMapping"];
  readonly groupToRole: TenantIdpDetail["groupToRole"];
}

export interface UpdateTenantIdpInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly metadataXml?: string;
  readonly attributeMapping?: TenantIdpDetail["attributeMapping"];
  readonly groupToRole?: TenantIdpDetail["groupToRole"];
}

export interface TenantIdpClient {
  list(): Promise<readonly TenantIdpSummary[]>;
  get(idpId: string): Promise<TenantIdpDetail>;
  create(input: CreateTenantIdpInput): Promise<TenantIdpDetail>;
  update(idpId: string, input: UpdateTenantIdpInput): Promise<TenantIdpDetail>;
  remove(idpId: string): Promise<void>;
}

export class TenantIdpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
  ) {
    super(`Tenant IdP API ${status}: ${errorCode ?? "unknown_error"}`);
    this.name = "TenantIdpApiError";
  }
}

export function createTenantIdpClient(config: AppConfig, idToken: string): TenantIdpClient | null {
  if (!config.apiBaseUrl) return null;
  const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;

  const fetchOrThrow = async (url: URL, init: RequestInit): Promise<Response> => {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
      },
    });
    if (!res.ok) {
      let errorCode: string | undefined;
      try {
        const body = (await res.clone().json()) as { error?: unknown };
        if (body && typeof body.error === "string") errorCode = body.error;
      } catch {
        /* noop */
      }
      throw new TenantIdpApiError(res.status, errorCode);
    }
    return res;
  };

  return {
    async list(): Promise<readonly TenantIdpSummary[]> {
      const url = new URL("tenant/idp", base);
      const res = await fetchOrThrow(url, { method: "GET" });
      const body = (await res.json()) as { items: readonly TenantIdpSummary[] };
      return body.items;
    },
    async get(idpId: string): Promise<TenantIdpDetail> {
      const url = new URL(`tenant/idp/${encodeURIComponent(idpId)}`, base);
      const res = await fetchOrThrow(url, { method: "GET" });
      return (await res.json()) as TenantIdpDetail;
    },
    async create(input: CreateTenantIdpInput): Promise<TenantIdpDetail> {
      const url = new URL("tenant/idp", base);
      const res = await fetchOrThrow(url, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (res.status !== StatusCodes.CREATED) {
        throw new TenantIdpApiError(res.status, "unexpected_status");
      }
      return (await res.json()) as TenantIdpDetail;
    },
    async update(idpId: string, input: UpdateTenantIdpInput): Promise<TenantIdpDetail> {
      const url = new URL(`tenant/idp/${encodeURIComponent(idpId)}`, base);
      const res = await fetchOrThrow(url, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      return (await res.json()) as TenantIdpDetail;
    },
    async remove(idpId: string): Promise<void> {
      const url = new URL(`tenant/idp/${encodeURIComponent(idpId)}`, base);
      await fetchOrThrow(url, { method: "DELETE" });
    },
  };
}

export function describeTenantIdpError(err: unknown): string {
  if (err instanceof TenantIdpApiError) {
    switch (err.status) {
      case StatusCodes.FORBIDDEN:
        return "forbidden — your account is not a TenantAdmin or belongs to a different tenant";
      case StatusCodes.NOT_FOUND:
        return "IdP not found in this tenant";
      case StatusCodes.CONFLICT:
        return "idpId already exists in this tenant";
      case StatusCodes.BAD_REQUEST:
        return err.errorCode === "invalid_metadata"
          ? "metadata XML rejected — check signing material / EntityID / NameIDFormat"
          : `invalid input — ${err.errorCode ?? "validation_failed"}`;
      default:
        return `Tenant IdP API error (${err.status}): ${err.errorCode ?? "unknown_error"}`;
    }
  }
  if (err instanceof Error) return err.message;
  return "unknown error";
}
