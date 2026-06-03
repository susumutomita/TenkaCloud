import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { bulkDeployEvent } from "../bulk-deploy.js";
import { handleRouteError, parseOptionalJsonBody, withEventId } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";
import { BulkDeployRequestSchema } from "../types.js";

/**
 * Bulk-deploy route — fan-out teams × problems into per-team Deployments.
 *
 *   POST /events/:eventId/deploy
 *
 * #555: body は opt-in。空 body は bulk-all 扱い (= 後方互換)。値が来た場合だけ
 * validate (= retryFailedOnly / teamIds / problemIds の filter として使う)。
 */
export function registerBulkDeployRoutes(app: Hono, shared: EventSharedResources): void {
  app.post(
    "/events/:eventId/deploy",
    withEventId(
      async ({ c, eventId }) => {
        const parsed = await parseOptionalJsonBody(c, BulkDeployRequestSchema);
        if (!parsed.ok) return parsed.response;
        try {
          const outcome = await bulkDeployEvent(
            shared,
            resolveTenantId(c),
            eventId,
            Date.now(),
            parsed.data,
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          auditEventAction(c, "bulk_deploy", eventId);
          return c.json(outcome.result, StatusCodes.ACCEPTED);
        } catch (err) {
          return handleRouteError(c, "[events] bulkDeployEvent failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
