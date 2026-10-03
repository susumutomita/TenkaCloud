import type { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import {
  resolveTenantId,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
} from "../../deploy-handler/auth.js";
import { ProgressionGateConfigSchema } from "../../shared/progression-gate.js";
import { auditEventAction } from "../audit.js";
import { removeProgressionGate, setProgressionGate } from "../progression-gate.js";
import { handleRouteError, parseJsonBody, withEventId } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) 設定 routes。
 *
 *   PUT    /events/:eventId/progression-gate   — Gate 設定を保存 (full-replace)
 *   DELETE /events/:eventId/progression-gate   — Gate 設定を除去 (idempotent)
 *
 * Event deploy 画面の `Advanced > Progression / Gate` からのみ呼ばれる想定。
 * PUT は per-tenant feature flag `challengePrerequisiteGate` (既定 OFF) が ON のときだけ
 * 受け付ける (= `feature_disabled` 409)。 DELETE は flag OFF でも許可 (掃除経路)。
 * roles は event 設計操作 (create / schedule) と同じ Admin + Operator。
 */
export function registerProgressionGateRoutes(app: Hono, shared: EventSharedResources): void {
  app.put(
    "/events/:eventId/progression-gate",
    withEventId(
      async ({ c, eventId }) => {
        const parsed = await parseJsonBody(c, ProgressionGateConfigSchema);
        if (!parsed.ok) return parsed.response;
        try {
          const outcome = await setProgressionGate(
            shared,
            resolveTenantId(c),
            eventId,
            parsed.data,
            Date.now(),
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          if (outcome.kind === "feature_disabled")
            return c.json({ error: "feature_disabled" }, StatusCodes.CONFLICT);
          if (outcome.kind === "invalid") {
            return c.json(
              { error: "invalid_progression_gate", reason: outcome.reason },
              StatusCodes.BAD_REQUEST,
            );
          }
          auditEventAction(c, "set_progression_gate", eventId);
          return c.json({ progressionGate: outcome.progressionGate }, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(c, "[events] setProgressionGate failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );

  app.delete(
    "/events/:eventId/progression-gate",
    withEventId(
      async ({ c, eventId }) => {
        try {
          const outcome = await removeProgressionGate(
            shared,
            resolveTenantId(c),
            eventId,
            Date.now(),
          );
          if (outcome.kind === "not_found")
            return c.json({ error: "not_found" }, StatusCodes.NOT_FOUND);
          auditEventAction(c, "remove_progression_gate", eventId);
          return c.json({ removed: outcome.removed }, StatusCodes.OK);
        } catch (err) {
          return handleRouteError(c, "[events] removeProgressionGate failed", { eventId }, err);
        }
      },
      { roles: [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE] },
    ),
  );
}
