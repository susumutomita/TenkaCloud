import type { Context, Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { requireRole, resolveTenantId, TENANT_ADMIN_ROLE } from "../../deploy-handler/auth.js";
import { exportTenantAuditCsv, listTenantAuditEntries } from "../audit-log-read.js";
import { handleRouteError, parseLimit } from "../route-helpers.js";
import type { EventSharedResources } from "../shared.js";

/**
 * Issue #1292: Tenant Admin 向け audit log read routes。
 *
 *   GET /admin/audit-log          — paginated, filter (from/to/principal/action)
 *   GET /admin/audit-log/export   — CSV stream
 *
 * cross-tenant 越境を物理的に不能 (= PK は `TENANT#<resolveTenantId(c)>` 固定、 query string
 * `tenantId` は読まない) にする。 既存 `/admin/insight/audit` は SystemAdmin Lambda 側
 * (= cross-tenant) で別経路、 本 route は Tenant Admin Lambda 側 (= self-tenant only) を
 * 提供する。
 */
export function registerAuditLogRoutes(app: Hono, shared: EventSharedResources): void {
  app.get("/admin/audit-log", (c) => handleAuditLogList(c, shared));
  app.get("/admin/audit-log/export", (c) => handleAuditLogExport(c, shared));
}

async function handleAuditLogList(c: Context, shared: EventSharedResources): Promise<Response> {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const auditTableName = process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "";
  if (auditTableName.length === 0) return auditLogUnconfigured(c);
  const parsedLimit = parseLimit(c.req.query("limit"));
  if (!parsedLimit) return c.json({ error: "invalid_limit" }, StatusCodes.BAD_REQUEST);
  const parsedFilters = parseAuditFilters(c);
  if (!parsedFilters.ok) return parsedFilters.response;
  try {
    const tenantId = resolveTenantId(c);
    const result = await listTenantAuditEntries(
      { ddb: shared.ddb, auditTableName },
      {
        tenantId,
        ...(parsedLimit.limit ? { limit: parsedLimit.limit } : {}),
        ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
        ...parsedFilters.filters,
      },
    );
    return c.json(result, StatusCodes.OK);
  } catch (err) {
    return handleRouteError(c, "[events] listTenantAuditEntries failed", {}, err);
  }
}

async function handleAuditLogExport(c: Context, shared: EventSharedResources): Promise<Response> {
  requireRole(c, [TENANT_ADMIN_ROLE]);
  const auditTableName = process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "";
  if (auditTableName.length === 0) return auditLogUnconfigured(c);
  const parsedFilters = parseAuditFilters(c);
  if (!parsedFilters.ok) return parsedFilters.response;
  try {
    const tenantId = resolveTenantId(c);
    const csv = await exportTenantAuditCsv(
      { ddb: shared.ddb, auditTableName },
      { tenantId, ...parsedFilters.filters },
    );
    return csvResponse(csv, tenantId);
  } catch (err) {
    return handleRouteError(c, "[events] exportTenantAuditCsv failed", {}, err);
  }
}

interface AuditFilters {
  readonly from?: string;
  readonly to?: string;
  readonly principal?: string;
  readonly action?: string;
}

type ParsedAuditFilters =
  | { readonly ok: true; readonly filters: AuditFilters }
  | { readonly ok: false; readonly response: Response };

function parseAuditFilters(c: Context): ParsedAuditFilters {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (isInvalidDate(from)) {
    return { ok: false, response: c.json({ error: "invalid_from" }, StatusCodes.BAD_REQUEST) };
  }
  if (isInvalidDate(to)) {
    return { ok: false, response: c.json({ error: "invalid_to" }, StatusCodes.BAD_REQUEST) };
  }
  return {
    ok: true,
    filters: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(c.req.query("principal") ? { principal: c.req.query("principal") } : {}),
      ...(c.req.query("action") ? { action: c.req.query("action") } : {}),
    },
  };
}

function isInvalidDate(value: string | undefined): boolean {
  return value !== undefined && Number.isNaN(new Date(value).getTime());
}

function auditLogUnconfigured(c: Context): Response {
  return c.json({ error: "audit_log_unconfigured" }, StatusCodes.SERVICE_UNAVAILABLE);
}

function csvResponse(csv: string, tenantId: string): Response {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new Response(csv, {
    status: StatusCodes.OK,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-tenant-${tenantId}-${stamp}.csv"`,
    },
  });
}
