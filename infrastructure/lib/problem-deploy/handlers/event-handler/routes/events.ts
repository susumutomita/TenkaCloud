import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { ULID_RE } from "../../shared/constants.js";
import { auditEventAction } from "../audit.js";
import { bulkTeardownEvent } from "../bulk-delete.js";
import { createEvent, DuplicateInternalSlugError, DuplicateProblemIdError } from "../create.js";
import { getEventDetail, listEvents } from "../list.js";
import { rotateTeamLoginKey } from "../rotate-team-login-key.js";
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
      try {
        const detail = await getEventDetail(shared, resolveTenantId(c), eventId, {
          withScoreEvents,
        });
        if (!detail) return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
        return c.json(detail, StatusCodes.OK);
      } catch (err) {
        return handleRouteError(c, "[events] getEventDetail failed", { eventId }, err);
      }
    }),
  );

  app.post(
    "/events/:eventId/teams/:teamId/rotate-login-key",
    withEventId(
      async ({ c, eventId }) => {
        const teamId = c.req.param("teamId");
        if (!ULID_RE.test(teamId)) {
          return c.json({ error: "invalid_team_id" }, StatusCodes.BAD_REQUEST);
        }
        try {
          const outcome = await rotateTeamLoginKey(
            shared,
            resolveTenantId(c),
            eventId,
            teamId,
            Date.now(),
          );
          if (outcome.kind === "not_found") {
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          }
          if (outcome.kind === "conflict") {
            return c.json({ error: "rotation_conflict" }, StatusCodes.CONFLICT);
          }
          auditEventAction(c, "rotate_team_login_key", `${eventId}/${teamId}`);
          return c.json(outcome, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(
            c,
            "[events] rotateTeamLoginKey failed",
            { eventId, teamId },
            err,
          );
        }
      },
      {
        roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE],
        rejectSuspendedTenant: true,
      },
    ),
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
