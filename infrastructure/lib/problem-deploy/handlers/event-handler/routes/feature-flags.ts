import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  requireRole,
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_ROLES,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { FeatureFlagsPatchSchema, getFeatureFlags, putFeatureFlags } from "../feature-flags.js";
import { handleRouteError, withJsonBody } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #2231: per-tenant runtime feature-flag toggle.
 *
 *   GET /feature-flags         — current stored overrides (registry defaults for absent keys)
 *   PUT /admin/feature-flags   — full-replace the override set
 *
 * Read and write are deliberately split across two authorization scopes, NOT a single
 * `/admin/*`-only pair: `config.features` (web-kit `resolveFeatureFlags`) must resolve for
 * every logged-in tenant role, because flags gate UI a TenantOperator / TenantViewer can also
 * reach (e.g. `redTeam` gates the Disruptions tab on EventDetail, which all three roles can
 * view). Restricting GET to TenantAdmin would 403 the app's own config load for two of the
 * three roles. Writing remains TenantAdmin-only (`/admin/*` blanket in index.ts + explicit
 * `requireRole` below) — only the toggle action, not the read, is an admin operation.
 */
export function registerFeatureFlagsRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/feature-flags", async (c) => {
    requireRole(c, TENANT_ROLES);
    try {
      const flags = await getFeatureFlags(shared, resolveTenantId(c));
      return c.json({ flags }, StatusCodes.OK);
    } catch (err) {
      return handleRouteError(c, "[events] getFeatureFlags failed", {}, err);
    }
  });

  app.put(
    "/admin/feature-flags",
    withJsonBody(
      FeatureFlagsPatchSchema,
      async ({ c, body }) => {
        try {
          const flags = await putFeatureFlags(
            shared,
            resolveTenantId(c),
            body,
            resolveCognitoSub(c),
            Date.now(),
          );
          auditEventAction(c, "update_feature_flags", "feature-flags");
          return c.json({ flags }, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(c, "[events] putFeatureFlags failed", {}, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE] },
    ),
  );
}
