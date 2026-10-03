import { createCoreApiClient } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import { decodeIdToken, resolveTenantConsoleAccess } from "../auth/claims";
import { type AppConfig, isLocalHost } from "../config";
import type { ApiClient } from "./client-contract";
// Issue #1954: demo mode の fixture client (call-time のみ参照)。
import { createDemoApiClient } from "./demo-client";

// Issue #2226: fetch->ApiError plumbing + the get/post/put/patch/del/delJson method
// superset now live in @tenkacloud/web-kit's createCoreApiClient (shared with
// admin-console); re-exported here so existing imports of ApiError from this
// module are unchanged. This app layers `tenantAccess` (RBAC) on top of the core.
export { ApiError } from "@tenkacloud/web-kit";
export type { ApiClient } from "./client-contract";

export function createApiClient(baseUrl: string, idToken: string): ApiClient {
  const claims = decodeIdToken(idToken);
  return {
    ...createCoreApiClient(baseUrl, idToken),
    tenantAccess: resolveTenantConsoleAccess(claims),
    organizerRole: claims?.["custom:organizerRole"],
    cloudOrganizerRole: claims?.["custom:userRole"],
  };
}

export function canMutateTenant(apiClient: ApiClient | null): boolean {
  if (!apiClient) return false;
  return apiClient.tenantAccess?.canMutateTenant ?? true;
}

export function canManageConnections(config: AppConfig, apiClient: ApiClient | null): boolean {
  if (!canMutateTenant(apiClient)) return false;
  if (isLocalHost(config)) return apiClient?.organizerRole === "Admin";
  if (config.mode === "demo") return true;
  // The restored cloud API checks TenantAdmin; the earlier cloud-host API used Admin.
  // Neither operator role may manage the competitor-account trust relationship.
  return (
    apiClient?.cloudOrganizerRole === "Admin" ||
    (config.mode === undefined && apiClient?.cloudOrganizerRole === "TenantAdmin")
  );
}

export function useApiClient(config: AppConfig): ApiClient | null {
  const auth = useAuth();
  return useMemo(() => {
    // Issue #1954: demo mode は fixture client に差し替え (実 AWS / backend を叩かない)。
    if (config.mode === "demo") return createDemoApiClient();
    return auth.tokens ? createApiClient(config.apiBaseUrl, auth.tokens.idToken) : null;
  }, [auth.tokens, config.apiBaseUrl, config.mode]);
}
