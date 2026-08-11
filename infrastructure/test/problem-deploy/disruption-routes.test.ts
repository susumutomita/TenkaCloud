import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: Red Team disruption routes (routes/disruptions.ts, #888 Phase A) の
 * route 層を pin する。 GET /disruptions, GET /disruptions/audit, POST /disruptions/fire の
 * ownership guard (requireEventOwnership)・ parseLimit・ 全 fire outcome→HTTP 分岐・ error path。
 *
 * disruption-fire module 全体を mock: service 3 本 (catalog / audit / fire) に加え、
 * route-helpers の requireEventOwnership が内部で呼ぶ isEventOwnedByTenant も差し替える
 * (同 module export なので 1 つの vi.mock で両方を制御できる)。
 */
const mocks = vi.hoisted(() => ({
  fireDisruption: vi.fn(),
  listDisruptionAudit: vi.fn(),
  listDisruptionCatalog: vi.fn(),
  isEventOwnedByTenant: vi.fn(),
  listActiveRecurring: vi.fn(),
  cancelRecurring: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/disruption-fire", () => ({
  fireDisruption: mocks.fireDisruption,
  listDisruptionAudit: mocks.listDisruptionAudit,
  listDisruptionCatalog: mocks.listDisruptionCatalog,
  isEventOwnedByTenant: mocks.isEventOwnedByTenant,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/disruption-recurring", () => ({
  listActiveRecurring: mocks.listActiveRecurring,
  cancelRecurring: mocks.cancelRecurring,
}));

const { registerDisruptionRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/disruptions"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared (service / ownership とも mock)。
const shared = { ddb: { send: vi.fn() }, eventsTableName: "events" } as any;
const buildApp = () => {
  const app = new Hono();
  registerDisruptionRoutes(app, shared);
  return app;
};
const get = (suffix: string) => buildApp().request(`/events/${EVENT_ID}/disruptions${suffix}`);
const fire = (body: unknown) =>
  buildApp().request(`/events/${EVENT_ID}/disruptions/fire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const validFireBody = {
  disruptionId: "d1",
  problemId: "p1",
  scope: "all",
  requestId: "req-12345678",
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEventOwnedByTenant.mockResolvedValue(true); // default: owned
});
afterEach(() => vi.clearAllMocks());

describe("GET /events/:eventId/disruptions", () => {
  it("should 404 when the event is not owned by the tenant", async () => {
    mocks.isEventOwnedByTenant.mockResolvedValueOnce(false);
    expect((await get("")).status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.listDisruptionCatalog).not.toHaveBeenCalled();
  });

  it("should 200 with the catalog when owned", async () => {
    mocks.listDisruptionCatalog.mockResolvedValueOnce({ disruptions: [] });
    const res = await get("");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ disruptions: [] });
  });

  it("should surface a catalog error (5xx)", async () => {
    mocks.listDisruptionCatalog.mockRejectedValueOnce(new Error("boom"));
    expect((await get("")).status).toBeGreaterThanOrEqual(500);
  });
});

describe("GET /events/:eventId/disruptions/audit", () => {
  it("should 400 on an invalid limit before touching ownership", async () => {
    const res = await get("/audit?limit=0");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_limit");
    expect(mocks.isEventOwnedByTenant).not.toHaveBeenCalled();
  });

  it("should 404 when not owned", async () => {
    mocks.isEventOwnedByTenant.mockResolvedValueOnce(false);
    expect((await get("/audit")).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 200 and pass limit + cursor through to the service", async () => {
    mocks.listDisruptionAudit.mockResolvedValueOnce({ items: [], cursor: null });
    const res = await get("/audit?limit=5&cursor=abc");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.listDisruptionAudit).toHaveBeenCalledWith(shared, EVENT_ID, {
      limit: 5,
      cursor: "abc",
    });
  });

  it("should default limit to undefined when omitted", async () => {
    mocks.listDisruptionAudit.mockResolvedValueOnce({ items: [] });
    await get("/audit");
    expect(mocks.listDisruptionAudit.mock.calls[0][2]).toMatchObject({ limit: undefined });
  });

  it("should surface an audit error (5xx)", async () => {
    mocks.listDisruptionAudit.mockRejectedValueOnce(new Error("boom"));
    expect((await get("/audit")).status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /events/:eventId/disruptions/fire", () => {
  it("should 400 on an invalid body", async () => {
    const res = await fire({ scope: "team" }); // missing required fields
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should 404 when not owned", async () => {
    mocks.isEventOwnedByTenant.mockResolvedValueOnce(false);
    expect((await fire(validFireBody)).status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should 201 on ok and apply parameter/target defaults for scope=all", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "ok", result: { fired: 3 } });
    const res = await fire(validFireBody);
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(await res.json()).toEqual({ fired: 3 });
    // parameters ?? {} と targetTeamIds ?? [] の default 経路。
    const call = mocks.fireDisruption.mock.calls[0][1];
    expect(call.parameters).toEqual({});
    expect(call.targetTeamIds).toEqual([]);
    expect(call.randomCount).toBeUndefined();
  });

  it("should 200 on duplicate and pass explicit parameters + targetTeamIds (scope=team)", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "duplicate", result: { fired: 0 } });
    const res = await fire({
      ...validFireBody,
      scope: "team",
      parameters: { latencyMs: 100 },
      targetTeamIds: ["team-1"],
    });
    expect(res.status).toBe(StatusCodes.OK);
    const call = mocks.fireDisruption.mock.calls[0][1];
    expect(call.parameters).toEqual({ latencyMs: 100 });
    expect(call.targetTeamIds).toEqual(["team-1"]);
  });

  it("should 400 when timing=scheduled but afterMinutes is missing", async () => {
    const res = await fire({ ...validFireBody, timing: "scheduled" });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should 400 when afterMinutes is set without timing=scheduled", async () => {
    const res = await fire({ ...validFireBody, afterMinutes: 30 });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should pass afterMinutes to the service when timing=scheduled", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "ok", result: { fired: 1 } });
    const res = await fire({ ...validFireBody, timing: "scheduled", afterMinutes: 30 });
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(mocks.fireDisruption.mock.calls[0][1].afterMinutes).toBe(30);
  });

  it("should not pass afterMinutes for an immediate fire (default timing)", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "ok", result: { fired: 1 } });
    await fire(validFireBody);
    expect(mocks.fireDisruption.mock.calls[0][1].afterMinutes).toBeUndefined();
  });

  it("should 400 when timing=recurring but intervalMinutes/maxFires are missing", async () => {
    const res = await fire({ ...validFireBody, timing: "recurring" });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should 400 when intervalMinutes/maxFires are set without timing=recurring", async () => {
    const res = await fire({ ...validFireBody, intervalMinutes: 5, maxFires: 6 });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.fireDisruption).not.toHaveBeenCalled();
  });

  it("should pass the recurrence to the service when timing=recurring", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "ok", result: { fired: 1 } });
    const res = await fire({
      ...validFireBody,
      timing: "recurring",
      intervalMinutes: 5,
      maxFires: 6,
    });
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(mocks.fireDisruption.mock.calls[0][1].recurrence).toEqual({
      intervalMinutes: 5,
      maxFires: 6,
    });
  });

  it("should include randomCount when scope=random-n", async () => {
    mocks.fireDisruption.mockResolvedValueOnce({ kind: "unknown_problem" });
    await fire({ ...validFireBody, scope: "random-n", randomCount: 2 });
    expect(mocks.fireDisruption.mock.calls[0][1].randomCount).toBe(2);
  });

  it.each([
    ["unknown_problem", { kind: "unknown_problem" }, StatusCodes.BAD_REQUEST, "unknown_problem"],
    [
      "unknown_disruption",
      { kind: "unknown_disruption" },
      StatusCodes.BAD_REQUEST,
      "unknown_disruption",
    ],
    [
      "invalid_parameters",
      { kind: "invalid_parameters", reason: "bad" },
      StatusCodes.BAD_REQUEST,
      "invalid_parameters",
    ],
    [
      "invalid_scope",
      { kind: "invalid_scope", reason: "bad" },
      StatusCodes.BAD_REQUEST,
      "invalid_scope",
    ],
    ["no_targets", { kind: "no_targets" }, StatusCodes.CONFLICT, "no_targets"],
    ["default", { kind: "unexpected_kind" }, StatusCodes.INTERNAL_SERVER_ERROR, "internal_error"],
  ])("should map the %s outcome to its HTTP response", async (_name, outcome, status, err) => {
    mocks.fireDisruption.mockResolvedValueOnce(outcome);
    const res = await fire(validFireBody);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(err);
  });

  it("should surface a fire error (5xx)", async () => {
    mocks.fireDisruption.mockRejectedValueOnce(new Error("boom"));
    expect((await fire(validFireBody)).status).toBeGreaterThanOrEqual(500);
  });
});

const getRecurring = () => buildApp().request(`/events/${EVENT_ID}/disruptions/recurring`);
const cancelRecurringReq = (requestId: string) =>
  buildApp().request(`/events/${EVENT_ID}/disruptions/recurring/${requestId}/cancel`, {
    method: "POST",
  });

describe("GET /events/:eventId/disruptions/recurring", () => {
  it("should 404 when the event is not owned by the tenant", async () => {
    mocks.isEventOwnedByTenant.mockResolvedValueOnce(false);
    expect((await getRecurring()).status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.listActiveRecurring).not.toHaveBeenCalled();
  });

  it("should 200 with the active recurring list when owned", async () => {
    mocks.listActiveRecurring.mockResolvedValueOnce({ items: [{ requestId: "r1" }] });
    const res = await getRecurring();
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).items).toHaveLength(1);
  });

  it("should surface a list error (5xx)", async () => {
    mocks.listActiveRecurring.mockRejectedValueOnce(new Error("boom"));
    expect((await getRecurring()).status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /events/:eventId/disruptions/recurring/:requestId/cancel", () => {
  it("should 404 when the event is not owned by the tenant", async () => {
    mocks.isEventOwnedByTenant.mockResolvedValueOnce(false);
    expect((await cancelRecurringReq("r1")).status).toBe(StatusCodes.NOT_FOUND);
    expect(mocks.cancelRecurring).not.toHaveBeenCalled();
  });

  it("should 200 when the recurring is cancelled", async () => {
    mocks.cancelRecurring.mockResolvedValueOnce("cancelled");
    const res = await cancelRecurringReq("r1");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.cancelRecurring).toHaveBeenCalledWith(
      shared,
      EVENT_ID,
      "tenant-test",
      "r1",
      expect.any(Number),
    );
  });

  it("should 404 when the recurring registry row is absent", async () => {
    mocks.cancelRecurring.mockResolvedValueOnce("not_found");
    expect((await cancelRecurringReq("missing")).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should surface a cancel error (5xx)", async () => {
    mocks.cancelRecurring.mockRejectedValueOnce(new Error("boom"));
    expect((await cancelRecurringReq("r1")).status).toBeGreaterThanOrEqual(500);
  });
});
