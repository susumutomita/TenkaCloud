import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { FeatureFlagsPatchSchema, getFeatureFlags, putFeatureFlags } from "../feature-flags.js";
import { handleRouteError, withJsonBody } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #2231 (ADR-035): per-tenant runtime feature-flag toggle.
 *
 *   GET /admin/feature-flags   — current stored overrides (registry defaults for absent keys)
 *   PUT /admin/feature-flags   — full-replace the override set
 *
 * Both routes live under `/admin/*`, which `index.ts` already gates to TENANT_ADMIN_ROLE for
 * every route on this Lambda (mirrors `/admin/audit-log`: reading operational config is an
 * admin action here, so TenantOperator / TenantViewer get neither read nor write). The
 * `requireRole` call below is defense-in-depth, not the primary gate.
 */
export function registerFeatureFlagsRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/admin/feature-flags", async (c) => {
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
