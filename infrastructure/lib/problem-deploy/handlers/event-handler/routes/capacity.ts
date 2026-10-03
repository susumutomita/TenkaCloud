import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { requireRole, TENANT_ADMIN_ROLE } from "../../deploy-handler/auth.js";
import { auditEventAction } from "../audit.js";
import {
  CapacityQuerySchema,
  CapacityUnconfiguredError,
  getCapacityOverview,
} from "../capacity.js";
import {
  CapacityNotApplicableError,
  CapacityScaleBodySchema,
  CapacityTableNotAllowedError,
  startCapacityScale,
} from "../capacity-scale.js";
import { handleRouteError } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #2410 Slice 2 / Issue #2680: イベント中の DynamoDB キャパシティ監視 + 変更 route。
 *
 *   GET  /admin/capacity?windowMinutes=30 — event-hot 5 テーブルの現行プロビジョン +
 *   直近 window の消費/throttle 集計 (+ Slice 1 runbook の document 名)
 *   POST /admin/capacity — Slice 1 の SSM runbook (StartAutomationExecution) を起動して
 *   1 テーブルの RCU/WCU を変更する (CLI と同じ document = 同じガード + 実行履歴)
 *
 * TenantAdmin 限定 (index.ts の `/admin/*` blanket middleware + 本 handler 1 行目の
 * `requireRole` の defense in depth)。GET は read-only なので audit log は書かず、
 * POST は success path で `capacity.scale` の監査行を 1 行残す。
 */
export function registerCapacityRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/admin/capacity", (c) => handleCapacityOverview(c, shared));
  app.post("/admin/capacity", (c) => handleCapacityScale(c, shared));
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
    return handleRouteError(c, "[events] getCapacityOverview failed", {}, err);
  }
}

async function handleCapacityScale(c: Context, shared: EventSharedResources): Promise<Response> {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_capacity_request" }, StatusCodes.BAD_REQUEST);
  }
  const parsed = CapacityScaleBodySchema.safeParse(raw);
  if (!parsed.success) {
    // ceiling (200) 超過もここで弾く = SSM parameter validation より手前の defense in depth。
    return c.json(
      { error: "invalid_capacity_request", issues: parsed.error.issues },
      StatusCodes.BAD_REQUEST,
    );
  }
  try {
    const result = await startCapacityScale(shared, parsed.data);
    auditEventAction(
      c,
      "capacity.scale",
      `${result.tableName} -> ${parsed.data.readCapacityUnits}/${parsed.data.writeCapacityUnits} RCU/WCU (execution ${result.executionId})`,
    );
    // UpdateTable は非同期 (runbook が受理された時点では未反映) なので 202 Accepted。
    return c.json(
      {
        executionId: result.executionId,
        tableName: result.tableName,
        role: result.role,
        readCapacityUnits: parsed.data.readCapacityUnits,
        writeCapacityUnits: parsed.data.writeCapacityUnits,
        status: "accepted",
      },
      StatusCodes.ACCEPTED,
    );
  } catch (err) {
    if (err instanceof CapacityUnconfiguredError) {
      return c.json({ error: "capacity_monitoring_unconfigured" }, StatusCodes.SERVICE_UNAVAILABLE);
    }
    if (err instanceof CapacityNotApplicableError) {
      // 純 SQL backend: scale 対象の DynamoDB table が構造的に存在しない。
      return c.json({ error: "capacity_not_applicable" }, StatusCodes.CONFLICT);
    }
    if (err instanceof CapacityTableNotAllowedError) {
      return c.json({ error: "invalid_table" }, StatusCodes.BAD_REQUEST);
    }
    return handleRouteError(c, "[events] startCapacityScale failed", {}, err);
  }
}
