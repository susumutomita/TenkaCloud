/**
 * Pure tier-guard factory for the Application Plane IdP CRUD Lambda.
 *
 * Extracted from `index.ts` so unit tests can exercise the fail-closed
 * pooled-tier behavior without importing the handler module (= which eagerly
 * calls `requireEnv("SAML_IDPS_TABLE_NAME")` and `requireEnv("TENANT_USER_POOL_ID")`
 * at module load).
 *
 * `tierGuard` mirrors the runtime `IDP_TIER_GUARD` env var. Only the literal
 * string `"silo"` opens the gate; everything else (undefined / pooled /
 * empty / typo) is treated as pooled-tier and returns 503.
 *
 * The Lambda runs only for silo (PLATINUM) tenants; the CDK side sets
 * `IDP_TIER_GUARD=silo` on that Lambda. If the env is absent or any other
 * value (= the Lambda got wired into a pooled deployment by mistake), the
 * handler returns 503 for every request — fail-closed at runtime even if
 * the CDK side regresses.
 */

import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  isTenantAdmin,
  resolveTenantId,
} from "../../../control-plane/handlers/idp-handler/auth.js";
import type { IdpScope } from "../../../control-plane/handlers/idp-handler/core.js";

export function createTenantIdpResolveScope(
  tierGuard: string | undefined,
): (c: Context) => IdpScope | { readonly forbidden: Response } {
  return (c: Context): IdpScope | { readonly forbidden: Response } => {
    if (tierGuard !== "silo") {
      return {
        forbidden: c.json(
          {
            error: "tenant_tier_not_silo",
            message:
              "Per-tenant SAML IdP CRUD requires a silo UserPool (PLATINUM tier). Contact support to upgrade.",
          },
          StatusCodes.SERVICE_UNAVAILABLE,
        ),
      };
    }
    if (!isTenantAdmin(c)) {
      return {
        forbidden: c.json({ error: "forbidden" }, StatusCodes.FORBIDDEN),
      };
    }
    const tenantId = resolveTenantId(c);
    if (!tenantId) {
      return {
        forbidden: c.json({ error: "forbidden_missing_tenant" }, StatusCodes.FORBIDDEN),
      };
    }
    return { kind: "tenant", tenantId };
  };
}
