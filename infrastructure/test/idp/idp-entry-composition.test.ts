import { describe, expect, it, vi } from "vitest";

/**
 * [#2527 Slice 4] Both IdP Lambda entry modules are composition roots: at module
 * scope they create their control-data runtime (`createDefaultControlDataRuntime()`)
 * and wire it into `createSeamIdpStore`. Importing them here pins that the cold
 * start composes without throwing (no Initialization Error) and exports a handler
 * — the same guarantee the other entrypoint families get from their route suites.
 * No AWS I/O happens at import time (clients are constructed, never invoked).
 */
describe("IdP Lambda entry composition roots", () => {
  it("should compose the Control Plane IdP entry without throwing at cold start", async () => {
    vi.stubEnv("CONTROL_PLANE_USER_POOL_ID", "pool-cp");
    try {
      const mod = await import("../../lib/control-plane/handlers/idp-handler/index");
      expect(typeof mod.handler).toBe("function");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should compose the Application Plane IdP entry without throwing at cold start", async () => {
    vi.stubEnv("TENANT_USER_POOL_ID", "pool-tenant");
    try {
      const mod = await import("../../lib/tenant-template/handlers/idp-handler/index");
      expect(typeof mod.handler).toBe("function");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
