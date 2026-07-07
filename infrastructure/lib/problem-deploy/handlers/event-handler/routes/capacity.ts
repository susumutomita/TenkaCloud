import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { requireRole, TENANT_ADMIN_ROLE } from "../../deploy-handler/auth.js";
import {
  CapacityQuerySchema,
  CapacityUnconfiguredError,
  getCapacityOverview,
} from "../capacity.js";
import { handleRouteError } from "../route-helpers.js";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 read route。
 *
 *   GET /admin/capacity?windowMinutes=30 — event-hot 5 テーブルの現行プロビジョン +
 *   直近 window の消費/throttle 集計 (+ Slice 1 runbook の document 名)
 *
 * TenantAdmin 限定 (index.ts の `/admin/*` blanket middleware + 本 handler 1 行目の
 * `requireRole` の defense in depth)。read-only なので audit log は書かない。
 */
export function registerCapacityRoutes(app: Hono): void {
  app.get("/admin/capacity", (c) => handleCapacityOverview(c));
}

async function handleCapacityOverview(c: Context): Promise<Response> {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const parsed = CapacityQuerySchema.safeParse({
    ...(c.req.query("windowMinutes") !== undefined
      ? { windowMinutes: c.req.query("windowMinutes") }
      : {}),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_window_minutes" }, StatusCodes.BAD_REQUEST);
  }
  try {
    const overview = await getCapacityOverview({ windowMinutes: parsed.data.windowMinutes });
    return c.json(overview, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CapacityUnconfiguredError) {
      // 旧 deploy chain (= env 未配線)。audit-log read の `audit_log_unconfigured` と同型。
      return c.json({ error: "capacity_monitoring_unconfigured" }, StatusCodes.SERVICE_UNAVAILABLE);
    }
    return handleRouteError(c, "[events] getCapacityOverview failed", {}, err);
  }
}
