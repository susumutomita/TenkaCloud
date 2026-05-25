import { StatusCodes } from "http-status-codes";
import type { AppConfig } from "../config";

/**
 * SAML IdP CRUD API client for the System Admin Console (Issue #1293).
 *
 * Talks to the Control Plane IdP Lambda (`/admin/idp/*`) using the same
 * `apiBaseUrl` as the tenant CRUD API. Both planes share the JWT contract.
 *
 * Returns `null` when `apiBaseUrl` is not configured (= dev fallback with no
 * runtime-config.json), so callers can render a "not wired up" alert.
 */

export type PlatformRole = "SystemAdmin" | "TenantAdmin" | "Operator" | "Viewer";

export interface IdpSummary {
  readonly idpId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly tenantId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdpDetail extends IdpSummary {
  readonly metadataXml: string;
  readonly attributeMapping: {
    readonly email: string;
    readonly displayName?: string;
    readonly groups?: string;
  };
  readonly groupToRole: Readonly<Record<string, PlatformRole>>;
}

export interface CreateIdpInput {
  readonly idpId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly metadataXml: string;
  readonly attributeMapping: IdpDetail["attributeMapping"];
  readonly groupToRole: IdpDetail["groupToRole"];
}

export interface UpdateIdpInput {
  readonly displayName?: string;
  readonly description?: string;
  readonly metadataXml?: string;
  readonly attributeMapping?: IdpDetail["attributeMapping"];
  readonly groupToRole?: IdpDetail["groupToRole"];
}

export interface IdpClient {
  list(): Promise<readonly IdpSummary[]>;
  get(idpId: string): Promise<IdpDetail>;
  create(input: CreateIdpInput): Promise<IdpDetail>;
  update(idpId: string, input: UpdateIdpInput): Promise<IdpDetail>;
  remove(idpId: string): Promise<void>;
}

export class IdpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string | undefined,
  ) {
    super(`IdP API ${status}: ${errorCode ?? "unknown_error"}`);
    this.name = "IdpApiError";
  }
}

export function createIdpClient(config: AppConfig, idToken: string): IdpClient | null {
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
      throw new IdpApiError(res.status, errorCode);
    }
    return res;
  };

  return {
    async list(): Promise<readonly IdpSummary[]> {
      const url = new URL("admin/idp", base);
      const res = await fetchOrThrow(url, { method: "GET" });
      const body = (await res.json()) as { items: readonly IdpSummary[] };
      return body.items;
    },
    async get(idpId: string): Promise<IdpDetail> {
      const url = new URL(`admin/idp/${encodeURIComponent(idpId)}`, base);
      const res = await fetchOrThrow(url, { method: "GET" });
      return (await res.json()) as IdpDetail;
    },
    async create(input: CreateIdpInput): Promise<IdpDetail> {
      const url = new URL("admin/idp", base);
      const res = await fetchOrThrow(url, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (res.status !== StatusCodes.CREATED) {
        throw new IdpApiError(res.status, "unexpected_status");
      }
      return (await res.json()) as IdpDetail;
    },
    async update(idpId: string, input: UpdateIdpInput): Promise<IdpDetail> {
      const url = new URL(`admin/idp/${encodeURIComponent(idpId)}`, base);
      const res = await fetchOrThrow(url, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      return (await res.json()) as IdpDetail;
    },
    async remove(idpId: string): Promise<void> {
      const url = new URL(`admin/idp/${encodeURIComponent(idpId)}`, base);
      await fetchOrThrow(url, { method: "DELETE" });
    },
  };
}

export function describeIdpError(err: unknown): string {
  if (err instanceof IdpApiError) {
    switch (err.status) {
      case StatusCodes.FORBIDDEN:
        return "forbidden — your account lacks the SystemAdmin role";
      case StatusCodes.NOT_FOUND:
        return "IdP not found";
      case StatusCodes.CONFLICT:
        return "idpId already exists";
      case StatusCodes.BAD_REQUEST:
        return err.errorCode === "invalid_metadata"
          ? "metadata XML rejected — check signing material / EntityID / NameIDFormat"
          : `invalid input — ${err.errorCode ?? "validation_failed"}`;
      default:
        return `IdP API error (${err.status}): ${err.errorCode ?? "unknown_error"}`;
    }
  }
  if (err instanceof Error) return err.message;
  return "unknown error";
}
