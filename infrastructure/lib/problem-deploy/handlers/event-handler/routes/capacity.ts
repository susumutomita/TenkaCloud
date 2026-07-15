import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { requireRole, TENANT_ADMIN_ROLE } from "../../deploy-handler/auth.js";
import {
  CapacityNotApplicableError,
  CapacityQuerySchema,
  CapacityUnconfiguredError,
  getCapacityOverview,
} from "../capacity.js";
import { handleRouteError } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #2410 Slice 2: イベント中の DynamoDB キャパシティ監視 read route。
 *
 *   GET /admin/capacity?windowMinutes=30 — event-hot 5 テーブルの現行プロビジョン +
 *   直近 window の消費/throttle 集計 (+ Slice 1 runbook の document 名)
 *
 * TenantAdmin 限定 (index.ts の `/admin/*` blanket middleware + 本 handler 1 行目の
 * `requireRole` の defense in depth)。read-only なので audit log は書かない。
 */
export function registerCapacityRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/admin/capacity", (c) => handleCapacityOverview(c, shared));
}

async function handleCapacityOverview(c: Context, shared: EventSharedResources): Promise<Response> {
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
    const overview = await getCapacityOverview(shared, {
      windowMinutes: parsed.data.windowMinutes,
    });
    return c.json(overview, StatusCodes.OK);
  } catch (err) {
    if (err instanceof CapacityUnconfiguredError) {
      // 旧 deploy chain (= env 未配線)。audit-log read の `audit_log_unconfigured` と同型。
      return c.json({ error: "capacity_monitoring_unconfigured" }, StatusCodes.SERVICE_UNAVAILABLE);
    }
    if (err instanceof CapacityNotApplicableError) {
      // Issue #2648: 純 SQL backend は DynamoDB を使わないので容量監視は恒久的に非該当。
      // 404 で「このリソースはこの構成に存在しない」を表し、frontend は panel を出さない。
      return c.json({ error: "capacity_not_applicable" }, StatusCodes.NOT_FOUND);
    }
    return handleRouteError(c, "[events] getCapacityOverview failed", {}, err);
  }
}
