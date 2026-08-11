import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveCognitoSub,
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import { fireDisruption, listDisruptionAudit, listDisruptionCatalog } from "../disruption-fire.js";
import { cancelRecurring, listActiveRecurring } from "../disruption-recurring.js";
import type { DisruptionFireOutcome } from "../disruption-types.js";
import {
  handleRouteError,
  parseJsonBody,
  parseLimit,
  requireEventOwnership,
  withEventId,
} from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";
import { type DisruptionFireRequest, DisruptionFireRequestSchema } from "../types.js";

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
 * recurring 一覧。 ownership 検証 → 動作中 (未 cancel + endsAt 未到達) を返す。
 * inline handler から切り出し、 registerDisruptionRoutes の cognitive complexity を抑える。
 */
async function handleRecurringList(
  c: Context,
  shared: EventSharedResources,
  eventId: string,
): Promise<Response> {
  const tenantId = resolveTenantId(c);
  const ownershipError = await requireEventOwnership({ c, shared, eventId, tenantId });
  if (ownershipError) return ownershipError;
  const out = await listActiveRecurring(shared, eventId, tenantId, Date.now());
  return c.json(out, StatusCodes.OK);
}

/**
 * recurring の早期解除。 ownership 検証 → schedule 削除 → registry に cancelledAt。
 * route の inline handler から切り出し、 registerDisruptionRoutes の cognitive complexity を抑える。
 */
async function handleRecurringCancel(
  c: Context,
  shared: EventSharedResources,
  eventId: string,
): Promise<Response> {
  const requestId = c.req.param("requestId");
  if (!requestId) return c.json({ error: "invalid_request_id" }, StatusCodes.BAD_REQUEST);
  const tenantId = resolveTenantId(c);
  const ownershipError = await requireEventOwnership({ c, shared, eventId, tenantId });
  if (ownershipError) return ownershipError;
  const outcome = await cancelRecurring(shared, eventId, tenantId, requestId, Date.now());
  if (outcome === "not_found") return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
  auditEventAction(c, "cancel_recurring_disruption", eventId);
  return c.json({ ok: true }, StatusCodes.OK);
}

/** timing=recurring のときだけ recurrence を載せる (schema が cross-field を保証済)。 */
function recurrenceInput(req: DisruptionFireRequest): {
  recurrence?: { intervalMinutes: number; maxFires: number };
} {
  if (
    req.timing === "recurring" &&
    req.intervalMinutes !== undefined &&
    req.maxFires !== undefined
  ) {
    return { recurrence: { intervalMinutes: req.intervalMinutes, maxFires: req.maxFires } };
  }
  return {};
}

/**
 * disruption fire の本体。 Zod parse → ownership 検証 → service。 inline handler から切り出し、
 * registerDisruptionRoutes の cognitive complexity 予算を守る (= 既存ロジックは不変)。
 */
async function handleDisruptionFire(
  c: Context,
  shared: EventSharedResources,
  eventId: string,
): Promise<Response> {
  // PR #889 review: 既存 route と整合する Zod parse に統一 (= cross-field 制約も含めて検証)
  const parsed = await parseJsonBody(c, DisruptionFireRequestSchema);
  if (!parsed.ok) return parsed.response;
  const req = parsed.data;
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
    // schema は afterMinutes を timing=scheduled の時のみ許す (= 存在 = scheduled)。
    ...(req.afterMinutes !== undefined ? { afterMinutes: req.afterMinutes } : {}),
    ...recurrenceInput(req),
    requestId: req.requestId,
    firedBy: resolveCognitoSub(c),
    nowMs: Date.now(),
  });
  if (outcome.kind === "ok") auditEventAction(c, "fire_disruption", eventId);
  return disruptionFireOutcomeResponse(c, outcome);
}

/**
 * recurring disruption の一覧 / 早期解除 route。 別関数に切り出すことで
 * registerDisruptionRoutes の cognitive complexity 予算を超えないようにする (= 単なる構造分割)。
 */
function registerRecurringRoutes(app: Hono, shared: EventSharedResources): void {
  app.get(
    "/events/:eventId/disruptions/recurring",
    withEventId(async ({ c, eventId }) => {
      try {
        return await handleRecurringList(c, shared, eventId);
      } catch (err) {
        return handleRouteError(c, "[disruptions] recurring list failed", { eventId }, err);
      }
    }),
  );

  app.post(
    "/events/:eventId/disruptions/recurring/:requestId/cancel",
    withEventId(
      async ({ c, eventId }) => {
        try {
          return await handleRecurringCancel(c, shared, eventId);
        } catch (err) {
          return handleRouteError(c, "[disruptions] recurring cancel failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
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
        const out = await listDisruptionCatalog(shared, tenantId, eventId);
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

  registerRecurringRoutes(app, shared);

  app.post(
    "/events/:eventId/disruptions/fire",
    withEventId(
      async ({ c, eventId }) => {
        try {
          return await handleDisruptionFire(c, shared, eventId);
        } catch (err) {
          return handleRouteError(c, "[disruptions] fire failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
