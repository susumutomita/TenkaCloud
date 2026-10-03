import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthErrorHandler } from "../../lib/problem-deploy/handlers/shared/auth-wiring";

/**
 * Issue #2283: PUT / DELETE /events/:eventId/progression-gate の route 層。
 * service (setProgressionGate / removeProgressionGate) は mock、 auth は dev override env で
 * 注入する (feature-flags-routes.test.ts と同じ pattern)。
 */
const mocks = vi.hoisted(() => ({
  setProgressionGate: vi.fn(),
  removeProgressionGate: vi.fn(),
  auditEventAction: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/event-handler/progression-gate", () => ({
  setProgressionGate: mocks.setProgressionGate,
  removeProgressionGate: mocks.removeProgressionGate,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/audit", () => ({
  auditEventAction: mocks.auditEventAction,
}));

const { registerProgressionGateRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/progression-gate"
);

// biome-ignore lint/suspicious/noExplicitAny: 最小 shared (route は service へ委譲するだけ)。
const shared = { ddb: { send: vi.fn() }, eventsTableName: "TestEvents" } as any;
const buildApp = () => {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[events]" }));
  registerProgressionGateRoutes(app, shared);
  return app;
};

const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/events/${EVENT_ID}/progression-gate`;
const config = {
  gateProblemId: "hello-world-battle",
  unlockTargetIds: ["stackstack-battle"],
  defaultPolicy: "required",
};

const putGate = (body: unknown, path = PATH) =>
  buildApp().request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

describe("PUT /events/:eventId/progression-gate", () => {
  it("should save the gate config and audit for a TenantAdmin caller", async () => {
    mocks.setProgressionGate.mockResolvedValueOnce({ kind: "ok", progressionGate: config });

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ progressionGate: config });
    expect(mocks.setProgressionGate).toHaveBeenCalledWith(
      shared,
      "tenant-test",
      EVENT_ID,
      config,
      expect.any(Number),
    );
    expect(mocks.auditEventAction).toHaveBeenCalledWith(
      expect.anything(),
      "set_progression_gate",
      EVENT_ID,
    );
  });

  it("should allow a TenantOperator caller (event design roles)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantOperator";
    mocks.setProgressionGate.mockResolvedValueOnce({ kind: "ok", progressionGate: config });

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.OK);
  });

  it("should reject a TenantViewer caller (fail-closed)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.setProgressionGate).not.toHaveBeenCalled();
  });

  it("should 409 with feature_disabled when the tenant flag is OFF", async () => {
    mocks.setProgressionGate.mockResolvedValueOnce({ kind: "feature_disabled" });

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect((await res.json()).error).toBe("feature_disabled");
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });

  it("should 400 with the machine-readable reason for cross-entity validation failures", async () => {
    mocks.setProgressionGate.mockResolvedValueOnce({
      kind: "invalid",
      reason: "unlock_target_not_in_event",
    });

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({
      error: "invalid_progression_gate",
      reason: "unlock_target_not_in_event",
    });
  });

  it("should 400 on a self-referencing gate before reaching the service (schema)", async () => {
    const res = await putGate({
      ...config,
      unlockTargetIds: ["hello-world-battle"],
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("validation_failed");
    expect(mocks.setProgressionGate).not.toHaveBeenCalled();
  });

  it("should 404 when the event is missing or owned by another tenant", async () => {
    mocks.setProgressionGate.mockResolvedValueOnce({ kind: "not_found" });

    const res = await putGate(config);

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 400 on an invalid eventId shape", async () => {
    const res = await putGate(config, "/events/not-a-ulid/progression-gate");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.setProgressionGate).not.toHaveBeenCalled();
  });

  it("should surface a service error via handleRouteError (5xx)", async () => {
    mocks.setProgressionGate.mockRejectedValueOnce(new Error("ddb boom"));
    const res = await putGate(config);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("DELETE /events/:eventId/progression-gate", () => {
  it("should remove the config and audit", async () => {
    mocks.removeProgressionGate.mockResolvedValueOnce({ kind: "ok", removed: true });

    const res = await buildApp().request(PATH, { method: "DELETE" });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ removed: true });
    expect(mocks.auditEventAction).toHaveBeenCalledWith(
      expect.anything(),
      "remove_progression_gate",
      EVENT_ID,
    );
  });

  it("should stay 200 (idempotent) when nothing was stored", async () => {
    mocks.removeProgressionGate.mockResolvedValueOnce({ kind: "ok", removed: false });

    const res = await buildApp().request(PATH, { method: "DELETE" });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ removed: false });
  });

  it("should reject a TenantViewer caller", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";

    const res = await buildApp().request(PATH, { method: "DELETE" });

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.removeProgressionGate).not.toHaveBeenCalled();
  });

  it("should 404 when the event is missing", async () => {
    mocks.removeProgressionGate.mockResolvedValueOnce({ kind: "not_found" });

    const res = await buildApp().request(PATH, { method: "DELETE" });

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });
});
