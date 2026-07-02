import { type CoreApiClient, createCoreApiClient } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

// Issue #2226: fetch->ApiError plumbing now lives in @tenkacloud/web-kit's
// createCoreApiClient (shared with application-admin-console); re-exported
// here so existing imports of ApiError from this module are unchanged.
export { ApiError } from "@tenkacloud/web-kit";

export type ApiClient = Pick<CoreApiClient, "get" | "post" | "del">;

export function createApiClient(config: AppConfig, idToken: string): ApiClient {
  return createCoreApiClient(config.apiBaseUrl, idToken);
}

export function useApiClient(config: AppConfig): ApiClient | null {
  const auth = useAuth();
  return useMemo(
    () => (auth.tokens ? createApiClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
  );
}
