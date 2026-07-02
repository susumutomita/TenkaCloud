import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthErrorHandler } from "../../lib/problem-deploy/handlers/shared/auth-wiring";

/**
 * Issue #2231: /feature-flags (GET, any tenant role) + /admin/feature-flags (PUT, TenantAdmin
 * only) route layer. Storage (getFeatureFlags / putFeatureFlags) is mocked; auth is injected
 * via the dev override env (mirrors audit-log-routes.test.ts). No JWT `sub` claim in these
 * requests, so `resolveCognitoSub` resolves to "unknown" (matches auth.ts's documented no-JWT
 * fallback — no DEFAULT_COGNITO_SUB override exists).
 */
const mocks = vi.hoisted(() => ({
  getFeatureFlags: vi.fn(),
  putFeatureFlags: vi.fn(),
  auditEventAction: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/event-handler/feature-flags", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../lib/problem-deploy/handlers/event-handler/feature-flags")
    >();
  return {
    ...actual,
    getFeatureFlags: mocks.getFeatureFlags,
    putFeatureFlags: mocks.putFeatureFlags,
  };
});
vi.mock("../../lib/problem-deploy/handlers/event-handler/audit", () => ({
  auditEventAction: mocks.auditEventAction,
}));

const { registerFeatureFlagsRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/feature-flags"
);

// biome-ignore lint/suspicious/noExplicitAny: 最小 shared (route は module 層に委譲するだけ)。
const shared = { ddb: { send: vi.fn() }, eventsTableName: "TestEvents" } as any;
const buildApp = () => {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix: "[events]" }));
  registerFeatureFlagsRoutes(app, shared);
  return app;
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

describe("GET /feature-flags", () => {
  it("should return the tenant's stored flags for a TenantAdmin caller", async () => {
    mocks.getFeatureFlags.mockResolvedValueOnce({ samlSso: true });

    const res = await buildApp().request("/feature-flags");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ flags: { samlSso: true } });
    expect(mocks.getFeatureFlags).toHaveBeenCalledWith(shared, "tenant-test");
  });

  it.each([
    "TenantOperator",
    "TenantViewer",
  ])("should return the tenant's stored flags for a %s caller (config.features must resolve for every role)", async (role) => {
    process.env.DEFAULT_USER_ROLE = role;
    mocks.getFeatureFlags.mockResolvedValueOnce({ redTeam: true });

    const res = await buildApp().request("/feature-flags");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ flags: { redTeam: true } });
  });

  it("should return {} when the tenant has no saved overrides", async () => {
    mocks.getFeatureFlags.mockResolvedValueOnce({});

    const res = await buildApp().request("/feature-flags");

    expect(await res.json()).toEqual({ flags: {} });
  });

  it("should surface a read error via handleRouteError (5xx)", async () => {
    mocks.getFeatureFlags.mockRejectedValueOnce(new Error("ddb boom"));

    const res = await buildApp().request("/feature-flags");

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("should reject a caller with no recognized tenant role (fail-closed)", async () => {
    delete process.env.DEFAULT_USER_ROLE;

    const res = await buildApp().request("/feature-flags");

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.getFeatureFlags).not.toHaveBeenCalled();
  });
});

describe("PUT /admin/feature-flags", () => {
  it("should reject a caller without TenantAdmin role", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";

    const res = await buildApp().request("/admin/feature-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samlSso: true }),
    });

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.putFeatureFlags).not.toHaveBeenCalled();
  });

  it("should 400 on a non-boolean value", async () => {
    const res = await buildApp().request("/admin/feature-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samlSso: "true" }),
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("validation_failed");
    expect(mocks.putFeatureFlags).not.toHaveBeenCalled();
  });

  it("should 400 on a malformed JSON body", async () => {
    const res = await buildApp().request("/admin/feature-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("should save, audit, and return the new flags for a valid TenantAdmin request", async () => {
    mocks.putFeatureFlags.mockResolvedValueOnce({ samlSso: true, redTeam: false });

    const res = await buildApp().request("/admin/feature-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samlSso: true, redTeam: false }),
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ flags: { samlSso: true, redTeam: false } });
    expect(mocks.putFeatureFlags).toHaveBeenCalledWith(
      shared,
      "tenant-test",
      { samlSso: true, redTeam: false },
      "unknown",
      expect.any(Number),
    );
    expect(mocks.auditEventAction).toHaveBeenCalledWith(
      expect.anything(),
      "update_feature_flags",
      "feature-flags",
    );
  });

  it("should surface a write error via handleRouteError (5xx)", async () => {
    mocks.putFeatureFlags.mockRejectedValueOnce(new Error("ddb boom"));

    const res = await buildApp().request("/admin/feature-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samlSso: true }),
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mocks.auditEventAction).not.toHaveBeenCalled();
  });
});
