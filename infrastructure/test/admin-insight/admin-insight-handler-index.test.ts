import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1418: admin-insight-handler/index.ts (Control Plane ops API, 352 行) は 9.73% branch
 * だった。 既存テストは service module (summary / audit / pipeline 等) を直接叩くため、 この
 * index.ts の app glue (onError / auditAndAuthorize / parseLimit / parseAuditListInput /
 * 各 route の outcome 分岐) を通っていなかった。
 *
 * 全 service module を mock し app を import。 buildSharedResources は hoisted object を返し、
 * auditTableName を test 毎に書き換えて unconfigured 枝を踏ませる。 auth (isSystemAdmin /
 * resolveCognitoSub) も mock。
 */
const mocks = vi.hoisted(() => ({
  sharedObj: {
    ddb: { send: () => Promise.resolve({}) },
    auditTableName: "Audit",
    environmentName: "dev",
  },
  isSystemAdmin: vi.fn(),
  resolveCognitoSub: vi.fn(),
  summarizeTenants: vi.fn(),
  listPipelineExecutions: vi.fn(),
  listStateMachineExecutions: vi.fn(),
  listAuditEntries: vi.fn(),
  exportAuditEntriesCsv: vi.fn(),
}));
const P = "../../lib/admin-insight/handlers/admin-insight-handler";
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/shared", () => ({
  buildSharedResources: () => mocks.sharedObj,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/auth", () => ({
  isSystemAdmin: mocks.isSystemAdmin,
  resolveCognitoSub: mocks.resolveCognitoSub,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/summary", () => ({
  summarizeTenants: mocks.summarizeTenants,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/pipeline-executions", () => ({
  defaultPipelineClient: {},
  listPipelineExecutions: mocks.listPipelineExecutions,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/state-machine-executions", () => ({
  defaultSfnClient: {},
  listStateMachineExecutions: mocks.listStateMachineExecutions,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/audit", () => ({
  listAuditEntries: mocks.listAuditEntries,
  exportAuditEntriesCsv: mocks.exportAuditEntriesCsv,
}));

const { app } = await import(`${P}/index`);

// onError を通すための test-only throwing route (handler 内 try/catch を経由しない)。
app.get("/__throw__", () => {
  throw new Error("boom");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedObj.auditTableName = "Audit";
  mocks.isSystemAdmin.mockReturnValue(true);
  mocks.resolveCognitoSub.mockReturnValue("sub-1");
});
afterEach(() => vi.clearAllMocks());

describe("wiring", () => {
  it("should serve healthz", async () => {
    const res = await app.request("/admin/insight/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("should map an uncaught throw to 500 via onError", async () => {
    const res = await app.request("/__throw__");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("internal_error");
  });
});

describe("GET /admin/insight/tenants/summary", () => {
  it("should 403 a non-SystemAdmin", async () => {
    mocks.isSystemAdmin.mockReturnValue(false);
    expect((await app.request("/admin/insight/tenants/summary")).status).toBe(
      StatusCodes.FORBIDDEN,
    );
  });
  it("should 200 with [] for an empty tenantIds query", async () => {
    const res = await app.request("/admin/insight/tenants/summary?tenantIds=%20");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ items: [] });
  });
  it("should 200 with [] when the tenantIds query is absent entirely", async () => {
    const res = await app.request("/admin/insight/tenants/summary"); // no ?tenantIds → ?? ""
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ items: [] });
  });
  it("should 400 on an invalid tenant id", async () => {
    const res = await app.request("/admin/insight/tenants/summary?tenantIds=ok,bad@id");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_tenant_id");
  });
  it("should 400 when too many tenant ids are requested", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `t${i}`).join(",");
    const res = await app.request(`/admin/insight/tenants/summary?tenantIds=${ids}`);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("too_many_tenant_ids");
  });
  it("should 200 with the summary on success", async () => {
    mocks.summarizeTenants.mockResolvedValueOnce({ items: [{ tenantId: "t1" }] });
    const res = await app.request("/admin/insight/tenants/summary?tenantIds=t1,t2");
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).items).toHaveLength(1);
  });
  it("should 500 when summarizeTenants throws", async () => {
    mocks.summarizeTenants.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request("/admin/insight/tenants/summary?tenantIds=t1")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /admin/insight/pipeline-executions", () => {
  it("should 403 a non-SystemAdmin", async () => {
    mocks.isSystemAdmin.mockReturnValue(false);
    expect((await app.request("/admin/insight/pipeline-executions")).status).toBe(
      StatusCodes.FORBIDDEN,
    );
  });
  it("should 400 on an invalid limit", async () => {
    expect((await app.request("/admin/insight/pipeline-executions?limit=0")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with executions", async () => {
    mocks.listPipelineExecutions.mockResolvedValueOnce({ items: [] });
    expect((await app.request("/admin/insight/pipeline-executions?limit=10")).status).toBe(
      StatusCodes.OK,
    );
  });
  it("should 500 when the service throws", async () => {
    mocks.listPipelineExecutions.mockRejectedValueOnce(new Error("cp"));
    expect((await app.request("/admin/insight/pipeline-executions")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /admin/insight/state-machine-executions", () => {
  it("should 403 a non-SystemAdmin", async () => {
    mocks.isSystemAdmin.mockReturnValue(false);
    expect((await app.request("/admin/insight/state-machine-executions")).status).toBe(
      StatusCodes.FORBIDDEN,
    );
  });
  it("should 400 on an invalid limit", async () => {
    expect((await app.request("/admin/insight/state-machine-executions?limit=abc")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 503 when not configured", async () => {
    mocks.listStateMachineExecutions.mockResolvedValueOnce({ kind: "not_configured" });
    expect((await app.request("/admin/insight/state-machine-executions")).status).toBe(
      StatusCodes.SERVICE_UNAVAILABLE,
    );
  });
  it("should 200 with executions", async () => {
    mocks.listStateMachineExecutions.mockResolvedValueOnce({ kind: "ok", items: [] });
    expect((await app.request("/admin/insight/state-machine-executions")).status).toBe(
      StatusCodes.OK,
    );
  });
  it("should 500 when the service throws", async () => {
    mocks.listStateMachineExecutions.mockRejectedValueOnce(new Error("sfn"));
    expect((await app.request("/admin/insight/state-machine-executions")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /admin/insight/audit", () => {
  it("should 403 a non-SystemAdmin", async () => {
    mocks.isSystemAdmin.mockReturnValue(false);
    expect((await app.request("/admin/insight/audit?scope=system")).status).toBe(
      StatusCodes.FORBIDDEN,
    );
  });
  it("should 503 when the audit table is unconfigured", async () => {
    mocks.sharedObj.auditTableName = "";
    expect((await app.request("/admin/insight/audit?scope=system")).status).toBe(
      StatusCodes.SERVICE_UNAVAILABLE,
    );
  });
  it("should 400 on an invalid scope (parseAuditListInput)", async () => {
    expect((await app.request("/admin/insight/audit?scope=weird")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with audit entries (scope=system)", async () => {
    mocks.listAuditEntries.mockResolvedValueOnce({ items: [], nextCursor: undefined });
    const res = await app.request(
      "/admin/insight/audit?scope=system&limit=5&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&principal=p&action=a&cursor=c",
    );
    expect(res.status).toBe(StatusCodes.OK);
  });
  it("should 500 when listAuditEntries throws", async () => {
    mocks.listAuditEntries.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request("/admin/insight/audit?scope=system")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("parseAuditListInput validation (via /audit)", () => {
  it("should 400 when scope=tenant lacks a valid tenantId", async () => {
    expect((await app.request("/admin/insight/audit?scope=tenant")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 for scope=tenant with a valid tenantId", async () => {
    mocks.listAuditEntries.mockResolvedValueOnce({ items: [] });
    expect((await app.request("/admin/insight/audit?scope=tenant&tenantId=t1")).status).toBe(
      StatusCodes.OK,
    );
  });
  it("should default scope to 'tenant' when the scope query is absent", async () => {
    // no ?scope → rawScope ?? "tenant" → tenant requires a valid tenantId.
    mocks.listAuditEntries.mockResolvedValueOnce({ items: [] });
    expect((await app.request("/admin/insight/audit?tenantId=t1")).status).toBe(StatusCodes.OK);
  });
  it("should 400 on an invalid limit", async () => {
    expect((await app.request("/admin/insight/audit?scope=system&limit=999")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 400 on an invalid from / to timestamp", async () => {
    expect((await app.request("/admin/insight/audit?scope=system&from=notadate")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
    expect((await app.request("/admin/insight/audit?scope=system&to=notadate")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
});

describe("GET /admin/insight/audit/export", () => {
  it("should 403 a non-SystemAdmin", async () => {
    mocks.isSystemAdmin.mockReturnValue(false);
    expect((await app.request("/admin/insight/audit/export?scope=system")).status).toBe(
      StatusCodes.FORBIDDEN,
    );
  });
  it("should 503 when unconfigured", async () => {
    mocks.sharedObj.auditTableName = "";
    expect((await app.request("/admin/insight/audit/export?scope=system")).status).toBe(
      StatusCodes.SERVICE_UNAVAILABLE,
    );
  });
  it("should 400 on invalid input", async () => {
    expect((await app.request("/admin/insight/audit/export?scope=weird")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 a CSV attachment for scope=system (platform filename)", async () => {
    mocks.exportAuditEntriesCsv.mockResolvedValueOnce("h1,h2\nv1,v2");
    const res = await app.request("/admin/insight/audit/export?scope=system");
    expect(res.status).toBe(StatusCodes.OK);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("audit-platform-");
  });
  it("should 200 a CSV attachment for scope=tenant (tenant filename)", async () => {
    mocks.exportAuditEntriesCsv.mockResolvedValueOnce("h1\nv1");
    const res = await app.request("/admin/insight/audit/export?scope=tenant&tenantId=t9");
    expect(res.headers.get("content-disposition")).toContain("audit-tenant-t9-");
  });
  it("should 500 when the export throws", async () => {
    mocks.exportAuditEntriesCsv.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request("/admin/insight/audit/export?scope=system")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });

  it("should pass all filters through to the exporter", async () => {
    mocks.exportAuditEntriesCsv.mockResolvedValueOnce("h\nv");
    await app.request(
      "/admin/insight/audit/export?scope=system&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&principal=p&action=a",
    );
    const arg = mocks.exportAuditEntriesCsv.mock.calls[0][1];
    expect(arg).toMatchObject({ from: expect.any(String), principal: "p", action: "a" });
  });
});

describe("non-Error rejections map to 500 ('unknown error' branch)", () => {
  it.each([
    ["/admin/insight/tenants/summary?tenantIds=t1", "summarizeTenants"],
    ["/admin/insight/pipeline-executions", "listPipelineExecutions"],
    ["/admin/insight/state-machine-executions", "listStateMachineExecutions"],
    ["/admin/insight/audit?scope=system", "listAuditEntries"],
    ["/admin/insight/audit/export?scope=system", "exportAuditEntriesCsv"],
  ])("should 500 for %s on a non-Error rejection", async (path, fnName) => {
    (mocks as Record<string, ReturnType<typeof vi.fn>>)[fnName].mockRejectedValueOnce(
      "plain string failure",
    );
    expect((await app.request(path)).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});
