import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { NotificationCreateRequestSchema } from "../../shared/notification.js";
import { auditEventAction } from "../audit.js";
import { createNotification } from "../create-notification.js";
import { handleRouteError, parseJsonBody, withEventId } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Operator → competitor notification route.
 *
 *   POST /events/:eventId/notifications
 */
export function registerNotificationRoutes(app: Hono, shared: EventSharedResources): void {
  app.post(
    "/events/:eventId/notifications",
    withEventId(
      async ({ c, eventId }) => {
        const parsed = await parseJsonBody(c, NotificationCreateRequestSchema);
        if (!parsed.ok) return parsed.response;
        try {
          const outcome = await createNotification(
            shared,
            resolveTenantId(c),
            eventId,
            resolveCognitoSub(c),
            parsed.data,
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          auditEventAction(c, "create_notification", eventId);
          return c.json(
            { notificationId: outcome.notificationId, occurredAt: outcome.occurredAt },
            StatusCodes.CREATED,
          );
        } catch (err) {
          return handleRouteError(c, "[events] createNotification failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
