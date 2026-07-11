import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";

/**
 * [#2527 Slice 4] Both IdP Lambda entry modules are composition roots: at module
 * scope they create their control-data runtime (`createDefaultControlDataRuntime()`)
 * and wire it into `createSeamIdpStore`. Importing them pins that the cold start
 * composes without throwing (no Initialization Error), and driving the exported
 * Hono apps through their I/O-free paths (healthz, auth gate, id validation, tier
 * guard) pins the composed wiring without touching any AWS client. The only lines
 * left unexercised are the two `now: () => new Date()` closures — invoking them
 * requires a mutating route call that reaches the real store/cognito clients.
 */

function systemAdminEnv(role: string): { event: unknown } {
  return {
    event: {
      requestContext: { authorizer: { jwt: { claims: { "custom:userRole": role } } } },
    },
  };
}

describe("Control Plane IdP entry (composition root)", () => {
  it("should compose at cold start and serve healthz", async () => {
    vi.stubEnv("CONTROL_PLANE_USER_POOL_ID", "pool-cp");
    try {
      const { app, handler } = await import("../../lib/control-plane/handlers/idp-handler/index");
      expect(typeof handler).toBe("function");
      const res = await app.request("/admin/idp/healthz");
      expect(res.status).toBe(StatusCodes.OK);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should reject a caller without the SystemAdmin role (forbidden gate)", async () => {
    vi.stubEnv("CONTROL_PLANE_USER_POOL_ID", "pool-cp");
    try {
      const { app } = await import("../../lib/control-plane/handlers/idp-handler/index");
      const res = await app.request("/admin/idp");
      expect(res.status).toBe(StatusCodes.FORBIDDEN);
      expect(await res.json()).toEqual({ error: "forbidden" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should resolve the system scope for a SystemAdmin and stop at id validation (no store I/O)", async () => {
    vi.stubEnv("CONTROL_PLANE_USER_POOL_ID", "pool-cp");
    try {
      const { app } = await import("../../lib/control-plane/handlers/idp-handler/index");
      const res = await app.request(
        "/admin/idp/not%20a%20valid%20id",
        {},
        systemAdminEnv("SystemAdmin"),
      );
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(await res.json()).toEqual({ error: "invalid_idp_id" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Application Plane IdP entry (composition root)", () => {
  it("should compose at cold start and keep the tier guard closed when IDP_TIER_GUARD is not silo", async () => {
    vi.stubEnv("TENANT_USER_POOL_ID", "pool-tenant");
    try {
      const { app, handler } = await import("../../lib/tenant-template/handlers/idp-handler/index");
      expect(typeof handler).toBe("function");
      const res = await app.request("/tenant/idp");
      expect(res.status).toBe(StatusCodes.SERVICE_UNAVAILABLE);
      expect((await res.json()).error).toBe("tenant_tier_not_silo");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
