import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Dedicated audit retirement keeps authorization and ordinary denial warnings intact. */

vi.spyOn(console, "warn").mockImplementation(() => undefined);

const { buildAuthErrorHandler, createRoleCheckMiddleware } = await import(
  "../../lib/problem-deploy/handlers/shared/auth-wiring"
);
const { TENANT_ADMIN_ROLE } = await import("../../lib/problem-deploy/handlers/deploy-handler/auth");
const { MachineRouteDeniedError } = await import(
  "../../lib/problem-deploy/handlers/shared/machine-principal"
);
type MachinePrincipal =
  import("../../lib/problem-deploy/handlers/shared/machine-principal").MachinePrincipal;

const ORIGINAL_ROLE = process.env.DEFAULT_USER_ROLE;
const ORIGINAL_TENANT = process.env.DEFAULT_TENANT_ID;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_ROLE === undefined) delete process.env.DEFAULT_USER_ROLE;
  else process.env.DEFAULT_USER_ROLE = ORIGINAL_ROLE;
  if (ORIGINAL_TENANT === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = ORIGINAL_TENANT;
});

function appWithAdminOnlyRoute(logPrefix: string): Hono {
  const app = new Hono();
  app.onError(buildAuthErrorHandler({ logPrefix }));
  app.use("*", createRoleCheckMiddleware({ healthzPath: "/healthz", roles: [TENANT_ADMIN_ROLE] }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.delete("/events/:eventId", (c) => c.json({ reached: true }));
  return app;
}

function humanEnv(role: string) {
  return {
    event: {
      requestContext: {
        authorizer: {
          claims: {
            "custom:tenantId": "tenant-1",
            "custom:userRole": role,
            sub: "cognito-sub-1",
            "cognito:username": "viewer@example.com",
            token_use: "id",
          },
        },
        identity: { sourceIp: "203.0.113.9", userAgent: "Mozilla/5.0" },
      },
    },
  };
}

describe("human role denial keeps operational warnings after audit retirement", () => {
  it.each(["[deploy]", "[events]"])(
    "preserves forbidden responses and warnings from %s",
    async (logPrefix) => {
      const res = await appWithAdminOnlyRoute(logPrefix).request(
        "/events/01H8XGJWBWBAQ4N6RZHM4S2KMV",
        { method: "DELETE" },
        humanEnv("TenantViewer"),
      );
      expect(res.status).toBe(StatusCodes.FORBIDDEN);
      expect(console.warn).toHaveBeenCalledWith(`${logPrefix} forbidden role`, expect.anything());
    },
  );

  it("preserves denial when the tenant cannot be resolved", async () => {
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_USER_ROLE;
    const app = appWithAdminOnlyRoute("[deploy]");
    const res = await app.request("/events/01H8XGJWBWBAQ4N6RZHM4S2KMV", { method: "DELETE" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
  });

  it("keeps allowed requests successful", async () => {
    const res = await appWithAdminOnlyRoute("[deploy]").request(
      "/events/01H8XGJWBWBAQ4N6RZHM4S2KMV",
      { method: "DELETE" },
      humanEnv("TenantAdmin"),
    );
    expect(res.status).toBe(StatusCodes.OK);
  });

  it("keeps healthz public", async () => {
    const res = await appWithAdminOnlyRoute("[deploy]").request("/healthz");
    expect(res.status).toBe(StatusCodes.OK);
  });
});

describe("machine route denial keeps operational warnings", () => {
  function appWithMachineDenial(principal: MachinePrincipal | undefined): Hono {
    const app = new Hono();
    app.onError(buildAuthErrorHandler({ logPrefix: "[deploy]" }));
    app.delete("/deployments/:jobId", () => {
      throw new MachineRouteDeniedError(
        principal ? "route_not_allowlisted" : "not_a_machine_principal",
        "DELETE",
        "/deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV",
        principal,
      );
    });
    return app;
  }

  it("denies a disallowed request with a known principal", async () => {
    const res = await appWithMachineDenial({
      tenantId: "tenant-1",
      clientId: "client-a",
      capabilities: ["read"],
    }).request("/deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV", { method: "DELETE" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(await res.json()).toMatchObject({ error: "forbidden_machine_route" });
    expect(console.warn).toHaveBeenCalledWith("[deploy] machine route denied", expect.anything());
  });

  it("denies a request without a resolved principal", async () => {
    const res = await appWithMachineDenial(undefined).request(
      "/deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV",
      { method: "DELETE" },
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(await res.json()).toMatchObject({ error: "forbidden_machine_route" });
    expect(console.warn).toHaveBeenCalledWith("[deploy] machine route denied", expect.anything());
  });
});
