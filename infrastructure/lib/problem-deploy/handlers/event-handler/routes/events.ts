import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  resolveUserRole,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { bulkTeardownEvent } from "../bulk-delete.js";
import { createEvent, DuplicateInternalSlugError, DuplicateProblemIdError } from "../create.js";
import { getEventDetail, listEvents } from "../list.js";
import { handleRouteError, parseLimit, withEventId, withJsonBody } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";
import { CreateEventRequestSchema } from "../types.js";

/**
 * Event CRUD + bulk-teardown routes.
 *
 *   POST   /events
 *   GET    /events
 *   GET    /events/:eventId
 *   DELETE /events/:eventId
 */
export function registerEventRoutes(app: Hono, shared: EventSharedResources): void {
  app.post(
    "/events",
    withJsonBody(
      CreateEventRequestSchema,
      async ({ c, body }) => {
        try {
          const response = await createEvent(
            shared,
            { tenantId: resolveTenantId(c), nowMs: Date.now() },
            body,
          );
          auditEventAction(c, "create_event", response.eventId);
          return c.json(response, StatusCodes.CREATED);
        } catch (err) {
          if (err instanceof DuplicateInternalSlugError) {
            return c.json(
              { error: "duplicate_internal_slug", slug: err.slug },
              StatusCodes.BAD_REQUEST,
            );
          }
          if (err instanceof DuplicateProblemIdError) {
            return c.json(
              { error: "duplicate_problem_id", problemId: err.problemId },
              StatusCodes.BAD_REQUEST,
            );
          }
          return handleRouteError(c, "[events] createEvent failed", {}, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE], rejectSuspendedTenant: true },
    ),
  );

  app.get("/events", async (c) => {
    const parsedLimit = parseLimit(c.req.query("limit"));
    if (!parsedLimit) return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
    try {
      const response = await listEvents(shared, {
        tenantId: resolveTenantId(c),
        limit: parsedLimit.limit,
        cursor: c.req.query("cursor"),
      });
      return c.json(response, StatusCodes.OK);
    } catch (err) {
      return handleRouteError(c, "[events] listEvents failed", {}, err);
    }
  });

  app.get(
    "/events/:eventId",
    withEventId(async ({ c, eventId }) => {
      // Issue #1038 P1 #7: opt-in で全 team の累計 score event timeline を返す。
      // default (= "true" 以外) は scoreEventsByTeam を省き、 既存 caller を素通り。
      const withScoreEvents = c.req.query("withScoreEvents") === "true";
      // #1392: teamLoginKey (participant bearer) は hand-off 担当の mutating role にのみ返す。
      // 読取り専用の TenantViewer には露出しない (= getEventDetail は default-deny)。
      const role = resolveUserRole(c);
      const includeLoginKeys = role === TENANT_ADMIN_ROLE || role === TENANT_OPERATOR_ROLE;
      try {
        const detail = await getEventDetail(shared, resolveTenantId(c), eventId, {
          withScoreEvents,
          includeLoginKeys,
        });
        if (!detail) return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
        return c.json(detail, StatusCodes.OK);
      } catch (err) {
        return handleRouteError(c, "[events] getEventDetail failed", { eventId }, err);
      }
    }),
  );

  app.delete(
    "/events/:eventId",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await bulkTeardownEvent(shared, resolveTenantId(c), eventId, Date.now());
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          auditEventAction(c, "delete_event", eventId);
          return c.json(outcome.result, StatusCodes.ACCEPTED);
        } catch (err) {
          return handleRouteError(c, "[events] bulkTeardownEvent failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE] },
    ),
  );
}
