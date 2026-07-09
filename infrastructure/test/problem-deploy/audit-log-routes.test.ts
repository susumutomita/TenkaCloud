import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424 / #1292: Tenant Admin の audit-log read routes (GET /admin/audit-log + /export)。
 * route 層 (routes/audit-log.ts) は未テストだったので、 unconfigured / limit / from-to /
 * filter / list / CSV export / error の全分岐を pin する。 read service (audit-log-read) は mock、
 * auth は dev override env (DEFAULT_TENANT_ID / DEFAULT_USER_ROLE) で TenantAdmin を inject。
 *
 * [Issue #2442 / Phase C4] The route now resolves an `AdminAuditLogRepository` (via
 * `resolveAdminAuditLogRepository` in `shared.ts`) and passes `{ repository }` to
 * `listTenantAuditEntries` / `exportTenantAuditCsv` instead of `{ ddb, auditTableName }`. `shared`
 * is rebuilt per request so it reflects the current `ADMIN_AUDIT_LOG_TABLE_NAME` env (mirrors the
 * pre-seam route, which read `process.env` fresh on every request).
 */
const mocks = vi.hoisted(() => ({
  listTenantAuditEntries: vi.fn(),
  exportTenantAuditCsv: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/event-handler/audit-log-read", () => ({
  listTenantAuditEntries: mocks.listTenantAuditEntries,
  exportTenantAuditCsv: mocks.exportTenantAuditCsv,
}));

const { registerAuditLogRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/audit-log"
);

const buildShared = () =>
  ({
    ddb: { send: vi.fn() },
    adminAuditLogTableName: process.env.ADMIN_AUDIT_LOG_TABLE_NAME ?? "",
    // biome-ignore lint/suspicious/noExplicitAny: 最小 shared (route は repository resolver に渡すだけ)。
  }) as any;
const buildApp = () => {
  const app = new Hono();
  registerAuditLogRoutes(app, buildShared());
  return app;
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditLog";
  mocks.listTenantAuditEntries.mockResolvedValue({ items: [], nextCursor: undefined });
  mocks.exportTenantAuditCsv.mockResolvedValue("ts,principal,action\n");
});
afterEach(() => {
  process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditLog";
});

describe("GET /admin/audit-log", () => {
  it("should 503 when the audit table is unconfigured", async () => {
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME; // undefined → `?? ""` RHS
    const res = await buildApp().request("/admin/audit-log");
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect(await res.json()).toEqual({ error: "audit_log_unconfigured" });
  });

  it("should 400 on an invalid limit", async () => {
    const res = await buildApp().request("/admin/audit-log?limit=abc");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_limit");
  });

  it("should 400 on an invalid from date", async () => {
    const res = await buildApp().request("/admin/audit-log?from=not-a-date");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_from");
  });

  it("should 400 on an invalid to date", async () => {
    const res = await buildApp().request("/admin/audit-log?to=not-a-date");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_to");
  });

  it("should return entries and pass tenantId + limit + cursor + filters through", async () => {
    mocks.listTenantAuditEntries.mockResolvedValueOnce({ items: [{ id: "a" }], nextCursor: "c2" });
    const res = await buildApp().request(
      "/admin/audit-log?limit=10&cursor=c1&principal=alice&action=DEPLOY&from=2026-06-01&to=2026-06-02",
    );
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ items: [{ id: "a" }], nextCursor: "c2" });
    expect(mocks.listTenantAuditEntries).toHaveBeenCalledWith(
      expect.objectContaining({ repository: expect.anything() }),
      expect.objectContaining({
        tenantId: "tenant-test",
        limit: 10,
        cursor: "c1",
        principal: "alice",
        action: "DEPLOY",
        from: "2026-06-01",
        to: "2026-06-02",
      }),
    );
  });

  it("should return entries with only tenantId when no filters are given", async () => {
    const res = await buildApp().request("/admin/audit-log");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.listTenantAuditEntries).toHaveBeenCalledWith(
      expect.objectContaining({ repository: expect.anything() }),
      { tenantId: "tenant-test" },
    );
  });

  it("should surface a read error via handleRouteError (5xx)", async () => {
    mocks.listTenantAuditEntries.mockRejectedValueOnce(new Error("ddb boom"));
    const res = await buildApp().request("/admin/audit-log");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("GET /admin/audit-log/export", () => {
  it("should 503 when the audit table is unconfigured", async () => {
    delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME; // undefined → `?? ""` RHS
    const res = await buildApp().request("/admin/audit-log/export");
    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
  });

  it("should 400 on an invalid filter date", async () => {
    const res = await buildApp().request("/admin/audit-log/export?from=nope");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_from");
  });

  it("should stream CSV with a tenant-scoped filename", async () => {
    mocks.exportTenantAuditCsv.mockResolvedValueOnce("ts,principal\n1,alice\n");
    const res = await buildApp().request("/admin/audit-log/export?principal=alice");
    expect(res.status).toBe(StatusCodes.OK);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("audit-tenant-tenant-test-");
    expect(await res.text()).toBe("ts,principal\n1,alice\n");
    expect(mocks.exportTenantAuditCsv).toHaveBeenCalledWith(
      expect.objectContaining({ repository: expect.anything() }),
      expect.objectContaining({ tenantId: "tenant-test", principal: "alice" }),
    );
  });

  it("should surface an export error via handleRouteError (5xx)", async () => {
    mocks.exportTenantAuditCsv.mockRejectedValueOnce(new Error("export boom"));
    const res = await buildApp().request("/admin/audit-log/export");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
