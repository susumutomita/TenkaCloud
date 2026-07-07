import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthErrorHandler } from "../../lib/problem-deploy/handlers/shared/auth-wiring";

/**
 * Issue #2410 Slice 2: GET /admin/capacity route layer (TenantAdmin only).
 * The capacity service is mocked; auth is injected via the dev override env
 * (mirrors feature-flags-routes.test.ts).
 */
const mocks = vi.hoisted(() => ({
  getCapacityOverview: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/event-handler/capacity", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../lib/problem-deploy/handlers/event-handler/capacity")
    >();
  return {
    ...actual,
    getCapacityOverview: mocks.getCapacityOverview,
  };
});

const { CapacityUnconfiguredError } = await import(
  "../../lib/problem-deploy/handlers/event-handler/capacity"
);
const { registerCapacityRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/capacity"
);

const buildApp = () => {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[events]" }));
  registerCapacityRoutes(app);
  return app;
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
afterEach(() => {
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

describe("GET /admin/capacity", () => {
  it("should return the capacity overview with the default 30-minute window", async () => {
    const overview = { windowMinutes: 30, ceiling: 200, tables: [] };
    mocks.getCapacityOverview.mockResolvedValueOnce(overview);

    const res = await buildApp().request("/admin/capacity");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual(overview);
    expect(mocks.getCapacityOverview).toHaveBeenCalledWith({ windowMinutes: 30 });
  });

  it("should pass a valid windowMinutes query through to the service", async () => {
    mocks.getCapacityOverview.mockResolvedValueOnce({ windowMinutes: 60, tables: [] });

    const res = await buildApp().request("/admin/capacity?windowMinutes=60");

    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.getCapacityOverview).toHaveBeenCalledWith({ windowMinutes: 60 });
  });

  it.each([
    "0",
    "4",
    "181",
    "abc",
  ])("should 400 on an invalid windowMinutes %s without touching AWS", async (value) => {
    const res = await buildApp().request(`/admin/capacity?windowMinutes=${value}`);

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_window_minutes");
    expect(mocks.getCapacityOverview).not.toHaveBeenCalled();
  });

  it.each([
    "TenantOperator",
    "TenantViewer",
  ])("should reject a %s caller (TenantAdmin only)", async (role) => {
    process.env.DEFAULT_USER_ROLE = role;

    const res = await buildApp().request("/admin/capacity");

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.getCapacityOverview).not.toHaveBeenCalled();
  });

  it("should 503 when the monitoring envs are not wired (old deploy chain)", async () => {
    mocks.getCapacityOverview.mockRejectedValueOnce(
      new CapacityUnconfiguredError("PROBLEM_ENDPOINTS_TABLE_NAME"),
    );

    const res = await buildApp().request("/admin/capacity");

    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect((await res.json()).error).toBe("capacity_monitoring_unconfigured");
  });

  it("should surface an AWS read error via handleRouteError (5xx)", async () => {
    mocks.getCapacityOverview.mockRejectedValueOnce(new Error("cloudwatch boom"));

    const res = await buildApp().request("/admin/capacity");

    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
