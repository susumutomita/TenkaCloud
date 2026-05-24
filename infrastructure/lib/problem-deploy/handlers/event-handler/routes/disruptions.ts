import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { fireDisruption, listDisruptionAudit, listDisruptionCatalog } from "../disruption-fire.js";
import type { DisruptionFireOutcome } from "../disruption-types.js";
import {
  handleRouteError,
  parseJsonBody,
  parseLimit,
  requireEventOwnership,
  withEventId,
} from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";
import { DisruptionFireRequestSchema } from "../types.js";

/**
 * Translate a `fireDisruption` outcome into an HTTP response. Kept as a flat
 * switch so the route handler stays under biome's cognitive-complexity budget.
 */
function disruptionFireOutcomeResponse(c: Context, outcome: DisruptionFireOutcome): Response {
  switch (outcome.kind) {
    case "ok":
      return c.json(outcome.result, StatusCodes.CREATED);
    case "duplicate":
      return c.json(outcome.result, StatusCodes.OK);
    case "unknown_problem":
      return c.json({ error: "unknown_problem" }, StatusCodes.BAD_REQUEST);
    case "unknown_disruption":
      return c.json({ error: "unknown_disruption" }, StatusCodes.BAD_REQUEST);
    case "invalid_parameters":
      return c.json(
        { error: "invalid_parameters", message: outcome.reason },
        StatusCodes.BAD_REQUEST,
      );
    case "invalid_scope":
      return c.json({ error: "invalid_scope", message: outcome.reason }, StatusCodes.BAD_REQUEST);
    case "no_targets":
      return c.json({ error: "no_targets" }, StatusCodes.CONFLICT);
    default:
      return c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Red Team disruption injection routes (Issue #888 Phase A).
 *
 *   GET  /events/:eventId/disruptions          — event 内 disruption catalog
 *   GET  /events/:eventId/disruptions/audit    — 発火履歴 (pagination)
 *   POST /events/:eventId/disruptions/fire     — disruption を fire
 *
 * All routes require tenant ownership of the event (PR #889 review): cross-tenant
 * lookup by obscured eventId is blocked at the handler boundary.
 */
export function registerDisruptionRoutes(app: Hono, shared: EventSharedResources): void {
  app.get(
    "/events/:eventId/disruptions",
    withEventId(async ({ c, eventId }) => {
      try {
        const tenantId = resolveTenantId(c);
        const ownershipError = await requireEventOwnership({ c, shared, eventId, tenantId });
        if (ownershipError) return ownershipError;
        const out = await listDisruptionCatalog(shared, eventId);
        return c.json(out, StatusCodes.OK);
      } catch (err) {
        return handleRouteError(c, "[disruptions] catalog failed", { eventId }, err);
      }
    }),
  );

  app.get(
    "/events/:eventId/disruptions/audit",
    withEventId(async ({ c, eventId }) => {
      const parsed = parseLimit(c.req.query("limit"));
      if (!parsed) return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
      const cursor = c.req.query("cursor");
      try {
        const tenantId = resolveTenantId(c);
        const ownershipError = await requireEventOwnership({ c, shared, eventId, tenantId });
        if (ownershipError) return ownershipError;
        const out = await listDisruptionAudit(shared, eventId, {
          limit: parsed.limit,
          cursor,
        });
        return c.json(out, StatusCodes.OK);
      } catch (err) {
        return handleRouteError(c, "[disruptions] audit list failed", { eventId }, err);
      }
    }),
  );

  app.post(
    "/events/:eventId/disruptions/fire",
    withEventId(
      async ({ c, eventId }) => {
        // PR #889 review: 既存 route と整合する Zod parse に統一 (= cross-field 制約も含めて検証)
        const parsed = await parseJsonBody(c, DisruptionFireRequestSchema);
        if (!parsed.ok) return parsed.response;
        const req = parsed.data;
        try {
          const tenantId = resolveTenantId(c);
          const ownershipError = await requireEventOwnership({ c, shared, eventId, tenantId });
          if (ownershipError) return ownershipError;
          const outcome = await fireDisruption(shared, {
            tenantId,
            eventId,
            problemId: req.problemId,
            disruptionId: req.disruptionId,
            parameters: req.parameters ?? {},
            scope: req.scope,
            targetTeamIds: req.targetTeamIds ?? [],
            ...(req.randomCount !== undefined ? { randomCount: req.randomCount } : {}),
            requestId: req.requestId,
            firedBy: resolveCognitoSub(c),
            nowMs: Date.now(),
          });
          return disruptionFireOutcomeResponse(c, outcome);
        } catch (err) {
          return handleRouteError(c, "[disruptions] fire failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
