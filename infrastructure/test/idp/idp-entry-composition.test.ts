import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";

/** Cold-start wiring for the retained cloud IdP Lambda, without AWS I/O. */
describe("Application Plane IdP entry (composition root)", () => {
  it("should compose at cold start and keep the tier guard closed when IDP_TIER_GUARD is not silo", async () => {
    vi.stubEnv("TENANT_USER_POOL_ID", "pool-tenant");
    vi.stubEnv("IDP_TIER_GUARD", undefined);
    try {
      const { app, handler } = await import("../../lib/tenant-template/handlers/idp-handler/index");
      expect(typeof handler).toBe("function");
      const health = await app.request("/tenant/idp/healthz");
      expect(health.status).toBe(StatusCodes.OK);
      const res = await app.request("/tenant/idp");
      expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
      expect((await res.json()).error).toBe("tenant_tier_not_silo");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
