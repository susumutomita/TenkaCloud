import { type CoreApiClient, createCoreApiClient } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  decodeIdToken,
  resolveTenantConsoleAccess,
  type TenantConsoleAccess,
} from "../auth/claims";
import type { AppConfig } from "../config";
// Issue #1954: demo mode の fixture client。 call-time のみ参照する循環 import (load-time は不使用)。
import { createDemoApiClient } from "./demo-client";

// Issue #2226: fetch->ApiError plumbing + the get/post/put/patch/del/delJson method
// superset now live in @tenkacloud/web-kit's createCoreApiClient (shared with
// admin-console); re-exported here so existing imports of ApiError from this
// module are unchanged. This app layers `tenantAccess` (RBAC) on top of the core.
export { ApiError } from "@tenkacloud/web-kit";

export interface ApiClient extends CoreApiClient {
  readonly tenantAccess?: TenantConsoleAccess;
}

export function createApiClient(baseUrl: string, idToken: string): ApiClient {
  return {
    ...createCoreApiClient(baseUrl, idToken),
    tenantAccess: resolveTenantConsoleAccess(decodeIdToken(idToken)),
  };
}

export function canMutateTenant(apiClient: ApiClient | null): boolean {
  if (!apiClient) return false;
  return apiClient.tenantAccess?.canMutateTenant ?? true;
}

export function useApiClient(config: AppConfig): ApiClient | null {
  const auth = useAuth();
  return useMemo(() => {
    // Issue #1954: demo mode は fixture client に差し替え (実 AWS / backend を叩かない)。
    if (config.mode === "demo") return createDemoApiClient();
    return auth.tokens ? createApiClient(config.apiBaseUrl, auth.tokens.idToken) : null;
  }, [auth.tokens, config.apiBaseUrl, config.mode]);
}
