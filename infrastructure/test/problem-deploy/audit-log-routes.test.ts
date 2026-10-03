import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send, resolveAudit } = vi.hoisted(() => ({ send: vi.fn(), resolveAudit: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/shared", () => ({
  buildEventSharedResources: () => ({
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    adminAuditLogTableName: "retained-history",
    ddb: { send },
    events: { send },
    problemsCatalog: {},
    runtime: { resolveAdminAuditLogRepository: resolveAudit },
  }),
  queryDeploymentsByEvent: vi.fn(),
}));
const { app } = await import("../../lib/problem-deploy/handlers/event-handler/index");
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEFAULT_TENANT_ID", "tenant-test");
  vi.stubEnv("DEFAULT_USER_ROLE", "TenantAdmin");
  vi.stubEnv("AUDIT_LOG_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("retired admin audit HTTP endpoints", () => {
  it.each(["/admin/audit-log", "/admin/audit-log/export"])(
    "returns 404 without opening retained audit storage: %s",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(resolveAudit).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("keeps the ordinary health endpoint available", async () => {
    const response = await app.request("/events/healthz");
    expect(response.status).toBe(200);
    expect(resolveAudit).not.toHaveBeenCalled();
  });
});
