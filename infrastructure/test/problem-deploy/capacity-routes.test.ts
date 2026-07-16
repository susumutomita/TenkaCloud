import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { buildAuthErrorHandler } from "../../lib/problem-deploy/handlers/shared/auth-wiring";

/**
 * Issue #2410 Slice 2 / #2680: GET+POST /admin/capacity route layer (TenantAdmin only).
 * The capacity service is mocked; auth is injected via the dev override env
 * (mirrors feature-flags-routes.test.ts). The POST audit line is asserted via the
 * mocked audit helper.
 */
const mocks = vi.hoisted(() => ({
  getCapacityOverview: vi.fn(),
  startCapacityScale: vi.fn(),
  auditEventAction: vi.fn(),
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
vi.mock(
  "../../lib/problem-deploy/handlers/event-handler/capacity-scale",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../lib/problem-deploy/handlers/event-handler/capacity-scale")
      >();
    return {
      ...actual,
      startCapacityScale: mocks.startCapacityScale,
    };
  },
);
vi.mock("../../lib/problem-deploy/handlers/event-handler/audit", () => ({
  auditEventAction: mocks.auditEventAction,
}));

const { CapacityUnconfiguredError } = await import(
  "../../lib/problem-deploy/handlers/event-handler/capacity"
);
const { CapacityNotApplicableError, CapacityTableNotAllowedError } = await import(
  "../../lib/problem-deploy/handlers/event-handler/capacity-scale"
);
const { registerCapacityRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/capacity"
);

// route は shared から 4 テーブル名を引く (capacity.ts の resolveEventHotTables)。
const shared = {
  deploymentsTableName: "Deployments-x",
  eventsTableName: "Events-x",
  teamsTableName: "Teams-x",
  disruptionsTableName: "Disruptions-x",
} as EventSharedResources;

const buildApp = () => {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[events]" }));
  registerCapacityRoutes(app, shared);
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
    expect(mocks.getCapacityOverview).toHaveBeenCalledWith(shared, { windowMinutes: 30 });
  });

  it("should pass a valid windowMinutes query through to the service", async () => {
    mocks.getCapacityOverview.mockResolvedValueOnce({ windowMinutes: 60, tables: [] });

    const res = await buildApp().request("/admin/capacity?windowMinutes=60");

    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.getCapacityOverview).toHaveBeenCalledWith(shared, { windowMinutes: 60 });
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

describe("POST /admin/capacity", () => {
  const BODY = { tableName: "Deployments-x", readCapacityUnits: 25, writeCapacityUnits: 10 };

  const postCapacity = (body: unknown = BODY) =>
    buildApp().request("/admin/capacity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("should 202 with the execution id and write one capacity.scale audit line", async () => {
    mocks.startCapacityScale.mockResolvedValueOnce({
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
    });

    const res = await postCapacity();

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(await res.json()).toEqual({
      executionId: "exec-123",
      tableName: "Deployments-x",
      role: "deployments",
      readCapacityUnits: 25,
      writeCapacityUnits: 10,
      status: "accepted",
    });
    expect(mocks.startCapacityScale).toHaveBeenCalledWith(shared, BODY);
    expect(mocks.auditEventAction).toHaveBeenCalledTimes(1);
    expect(mocks.auditEventAction).toHaveBeenCalledWith(
      expect.anything(),
      "capacity.scale",
      "Deployments-x -> 25/10 RCU/WCU (execution exec-123)",
    );
  });

  it("should 400 on a body that is not JSON without touching the service", async () => {
    const res = await postCapacity("{not json");

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_capacity_request");
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });

  it.each([
    ["a capacity above the ceiling", { ...BODY, readCapacityUnits: 201 }],
    ["a zero capacity", { ...BODY, writeCapacityUnits: 0 }],
    ["a non-integer capacity", { ...BODY, readCapacityUnits: 2.5 }],
    ["an empty tableName", { ...BODY, tableName: "" }],
  ])("should 400 with issues on %s (API-side ceiling re-validation)", async (_label, body) => {
    const res = await postCapacity(body);

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const payload = await res.json();
    expect(payload.error).toBe("invalid_capacity_request");
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
  });

  it("should 400 invalid_table when the table is outside the event-hot allowlist", async () => {
    mocks.startCapacityScale.mockRejectedValueOnce(new CapacityTableNotAllowedError("Other-x"));

    const res = await postCapacity({ ...BODY, tableName: "Other-x" });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_table");
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });

  it("should 503 when the runbook env is not wired (old deploy chain)", async () => {
    mocks.startCapacityScale.mockRejectedValueOnce(
      new CapacityUnconfiguredError("CAPACITY_RUNBOOK_DOCUMENT_NAME"),
    );

    const res = await postCapacity();

    expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
    expect((await res.json()).error).toBe("capacity_monitoring_unconfigured");
  });

  it("should 409 capacity_not_applicable on a pure SQL backend with no DynamoDB tables", async () => {
    mocks.startCapacityScale.mockRejectedValueOnce(new CapacityNotApplicableError());

    const res = await postCapacity();

    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect((await res.json()).error).toBe("capacity_not_applicable");
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });

  it("should surface an SSM error via handleRouteError (5xx) without an audit line", async () => {
    mocks.startCapacityScale.mockRejectedValueOnce(new Error("ssm boom"));

    const res = await postCapacity();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });

  it.each([
    "TenantOperator",
    "TenantViewer",
  ])("should reject a %s caller (TenantAdmin only)", async (role) => {
    process.env.DEFAULT_USER_ROLE = role;

    const res = await postCapacity();

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.startCapacityScale).not.toHaveBeenCalled();
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });
});
