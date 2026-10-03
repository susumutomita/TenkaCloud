import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
} from "../../deploy-handler/auth.js";
import { archiveEvent } from "../archive.js";
import { auditEventAction } from "../audit.js";
import { lockScoring, unlockScoring } from "../lock-scoring.js";
import { handleRouteError, withEventId } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Scoring lock + archive routes (#558, admin operations).
 *
 *   POST   /events/:eventId/lock-scoring
 *   DELETE /events/:eventId/lock-scoring
 *   POST   /events/:eventId/archive
 *
 * idempotent: already locked / unlocked returns 200 + current state.
 * status=READY / ENDED のみ lockable (加点経路があり得る state)。
 */
export function registerScoringRoutes(app: Hono, shared: EventSharedResources): void {
  app.post(
    "/events/:eventId/lock-scoring",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await lockScoring(
            shared,
            resolveTenantId(c),
            eventId,
            resolveCognitoSub(c),
            Date.now(),
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          if (outcome.kind === "not_lockable") {
            return c.json(
              { error: "not_lockable", currentStatus: outcome.status },
              StatusCodes.CONFLICT,
            );
          }
          auditEventAction(c, "lock_scoring", eventId);
          return c.json(
            {
              scoringLocked: outcome.scoringLocked,
              scoringLockedAt: outcome.kind === "ok" ? outcome.scoringLockedAt : undefined,
              idempotent: outcome.kind === "already",
            },
            StatusCodes.OK,
          );
        } catch (err) {
          return handleRouteError(c, "[events] lockScoring failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE] },
    ),
  );

  app.delete(
    "/events/:eventId/lock-scoring",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await unlockScoring(shared, resolveTenantId(c), eventId, Date.now());
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          if (outcome.kind === "not_lockable") {
            return c.json(
              { error: "not_lockable", currentStatus: outcome.status },
              StatusCodes.CONFLICT,
            );
          }
          auditEventAction(c, "unlock_scoring", eventId);
          return c.json(
            {
              scoringLocked: outcome.scoringLocked,
              idempotent: outcome.kind === "already",
            },
            StatusCodes.OK,
          );
        } catch (err) {
          return handleRouteError(c, "[events] unlockScoring failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE] },
    ),
  );

  app.post(
    "/events/:eventId/archive",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await archiveEvent(shared, resolveTenantId(c), eventId, Date.now());
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          if (outcome.kind === "not_archivable") {
            return c.json(
              { error: "not_archivable", currentStatus: outcome.status },
              StatusCodes.CONFLICT,
            );
          }
          auditEventAction(c, "archive_event", eventId);
          return c.json({ archivedAt: outcome.archivedAt }, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(c, "[events] archiveEvent failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE] },
    ),
  );
}
