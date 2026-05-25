import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1341 (#1335 Phase 3): `/admin/audit/export` HTTP route の挙動を pin する。
 *
 * - SystemAdmin 以外は 403 (= 既存 `auditAndAuthorize` 経路と同じ ADR-011 D2)
 * - `from` / `to` の date 形式不正 / 反転は 400
 * - 200 path は JSONL response + content-disposition attachment header
 */

const mocks = vi.hoisted(() => ({
  exportAuditArchive: vi.fn(),
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/shared", () => ({
  buildSharedResources: () => ({
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send: vi.fn() },
    auditTableName: "TestAudit",
    environmentName: "test-env",
  }),
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/audit-export-s3", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/admin-insight/handlers/admin-insight-handler/audit-export-s3")
  >("../../lib/admin-insight/handlers/admin-insight-handler/audit-export-s3");
  return {
    ...actual,
    exportAuditArchive: mocks.exportAuditArchive,
  };
});

const { app } = await import("../../lib/admin-insight/handlers/admin-insight-handler/index");

function withClaims(claims: Record<string, unknown>) {
  return { requestContext: { authorizer: { jwt: { claims } } } };
}

const ORIGINAL_BUCKET = process.env.AUDIT_ARCHIVE_BUCKET_NAME;

beforeEach(() => {
  process.env.AUDIT_ARCHIVE_BUCKET_NAME = "test-archive-bucket";
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_BUCKET === undefined) delete process.env.AUDIT_ARCHIVE_BUCKET_NAME;
  else process.env.AUDIT_ARCHIVE_BUCKET_NAME = ORIGINAL_BUCKET;
});

describe("GET /admin/audit/export (Issue #1341)", () => {
  it("should reject non-SystemAdmin callers with 403", async () => {
    const res = await app.request(
      "/admin/audit/export?from=2026-05-01&to=2026-05-31",
      {},
      { event: withClaims({ "custom:userRole": "TenantAdmin", sub: "u" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.exportAuditArchive).not.toHaveBeenCalled();
  });

  it("should return 503 when AUDIT_ARCHIVE_BUCKET_NAME is unset", async () => {
    delete process.env.AUDIT_ARCHIVE_BUCKET_NAME;
    const res = await app.request(
      "/admin/audit/export?from=2026-05-01&to=2026-05-31",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(503);
    expect(mocks.exportAuditArchive).not.toHaveBeenCalled();
  });

  it("should reject malformed date with 400", async () => {
    const res = await app.request(
      "/admin/audit/export?from=2026/05/01&to=2026-05-31",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(400);
  });

  it("should reject from > to with 400", async () => {
    const res = await app.request(
      "/admin/audit/export?from=2026-05-31&to=2026-05-01",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("from_after_to");
  });

  it("should reject unsupported format with 400", async () => {
    const res = await app.request(
      "/admin/audit/export?from=2026-05-01&to=2026-05-31&format=csv",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(400);
  });

  it("should return JSONL body with attachment headers on success", async () => {
    mocks.exportAuditArchive.mockResolvedValueOnce({
      body: '{"id":1}\n{"id":2}\n',
      objectCount: 2,
      bytes: 18,
      truncated: false,
    });
    const res = await app.request(
      "/admin/audit/export?from=2026-05-01&to=2026-05-31",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(
      'filename="audit-archive-2026-05-01_to_2026-05-31.jsonl"',
    );
    expect(res.headers.get("x-export-object-count")).toBe("2");
    expect(res.headers.get("x-export-truncated")).toBe("false");
    const text = await res.text();
    expect(text).toBe('{"id":1}\n{"id":2}\n');
    expect(mocks.exportAuditArchive).toHaveBeenCalledWith(
      expect.objectContaining({ bucketName: "test-archive-bucket" }),
      { from: "2026-05-01", to: "2026-05-31" },
    );
  });

  it("should propagate internal errors as 500", async () => {
    mocks.exportAuditArchive.mockRejectedValueOnce(new Error("s3 down"));
    const res = await app.request(
      "/admin/audit/export?from=2026-05-01&to=2026-05-31",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin" }) },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});
