import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { resetCoordinationRun } from "../coordination-reset.js";
import { handleRouteError, withEventId } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * [Issue #3126] Coordination run-reset route.
 *
 *   POST /events/:eventId/problems/:problemId/coordination/reset
 *
 * The explicit "start this match over" gesture. It exists as its own operation
 * — rather than as a side effect of re-deploying — because `POST
 * /events/:eventId/deploy` is used on events that are already running (adding a
 * late team, retrying a failed stack), and coordination state is shared by
 * every team on the problem. See `coordination-reset.ts` for the full argument.
 *
 * [Issue #3153] Starts a NEW run rather than deleting the namespace. The match
 * in progress ends and the next participant operation rebuilds from
 * `plugin.initialState`, but the run that just ended stays readable under its
 * own id until the retention window pushes it out — so an operator who resets
 * because something went wrong still has the evidence of what went wrong.
 *
 * Restricted to the same operator roles as deploy and teardown.
 */
export function registerCoordinationRoutes(app: Hono, shared: EventSharedResources): void {
  app.post(
    "/events/:eventId/problems/:problemId/coordination/reset",
    withEventId(
      async ({ c, eventId }) => {
        const problemId = c.req.param("problemId");
        if (!problemId) return c.json({ error: "problem_id_required" }, StatusCodes.BAD_REQUEST);
        try {
          const outcome = await resetCoordinationRun(
            shared,
            resolveTenantId(c),
            eventId,
            problemId,
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          // [Issue #3153] Another operator started a run first. 409 rather than
          // a retry: the caller should see which run is current before deciding
          // whether they still want one of their own.
          if (outcome.kind === "conflict")
            return c.json({ error: "run_rotation_conflict" }, StatusCodes.CONFLICT);
          auditEventAction(c, "coordination_run_reset", eventId);
          return c.json(outcome.result, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(
            c,
            "[events] resetCoordinationRun failed",
            { eventId, problemId },
            err,
          );
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE], rejectSuspendedTenant: true },
    ),
  );
}
