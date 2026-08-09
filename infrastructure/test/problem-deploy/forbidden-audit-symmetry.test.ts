import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #2954: 403 の監査を 3 handler で対称にする。
 *
 * これまで `ForbiddenRoleError` に対して audit 行を書いていたのは competitor-accounts-handler
 * だけで、競技運営そのものを担う deploy / event Lambda は `console.warn` を 1 行出すだけだった。
 * その結果、admin console の Audit Log 画面には「deploy を試みて弾かれた」「event を消そうと
 * して弾かれた」が 1 件も出てこない。両 Lambda が共有する `buildAuthErrorHandler` に書き込みを
 * 入れて、経路によって監査の粒度が変わらないようにする。
 */

const auditMocks = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/shared/audit-log", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/shared/audit-log")
  >("../../lib/problem-deploy/handlers/shared/audit-log");
  return { ...actual, writeAuditEvent: auditMocks.writeAuditEvent };
});

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
  auditMocks.writeAuditEvent.mockResolvedValue(true);
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

describe("#2954: a human role denial writes an audit row on the deploy and event Lambdas", () => {
  it.each([
    "[deploy]",
    "[events]",
  ])("should write a forbidden row from the %s handler", async (logPrefix) => {
    const res = await appWithAdminOnlyRoute(logPrefix).request(
      "/events/01H8XGJWBWBAQ4N6RZHM4S2KMV",
      { method: "DELETE" },
      humanEnv("TenantViewer"),
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actor: "cognito-sub-1",
        actorUsername: "viewer@example.com",
        action: "DELETE /events/01H8XGJWBWBAQ4N6RZHM4S2KMV",
        outcome: "forbidden",
        ipAddress: "203.0.113.9",
        extra: expect.objectContaining({
          actualRole: "TenantViewer",
          requiredRoles: TENANT_ADMIN_ROLE,
        }),
      }),
    );
  });

  it("should still write a row when the tenant cannot be resolved (the attempt is the audit subject)", async () => {
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_USER_ROLE;
    const app = appWithAdminOnlyRoute("[deploy]");
    const res = await app.request("/events/01H8XGJWBWBAQ4N6RZHM4S2KMV", { method: "DELETE" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "unknown",
        outcome: "forbidden",
        extra: expect.objectContaining({ actualRole: "(none)" }),
      }),
    );
  });

  it("should not write a row when the request is allowed", async () => {
    const res = await appWithAdminOnlyRoute("[deploy]").request(
      "/events/01H8XGJWBWBAQ4N6RZHM4S2KMV",
      { method: "DELETE" },
      humanEnv("TenantAdmin"),
    );
    expect(res.status).toBe(StatusCodes.OK);
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("should not write a row for healthz (no auth is applied there)", async () => {
    const res = await appWithAdminOnlyRoute("[deploy]").request("/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe("#2948: a machine route denial audits only when the principal is known", () => {
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

  it("should write a forbidden row against the bound tenant when the principal resolved", async () => {
    const res = await appWithMachineDenial({
      tenantId: "tenant-1",
      clientId: "client-a",
      capabilities: ["read"],
    }).request("/deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV", { method: "DELETE" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(await res.json()).toMatchObject({ error: "forbidden_machine_route" });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actor: "m2m:client-a",
        action: "DELETE /deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV",
        outcome: "forbidden",
        target: "route_not_allowlisted",
      }),
    );
  });

  it("should refuse to invent a tenant row when the principal could not be resolved", async () => {
    // `not_a_machine_principal` は tenant も actor も特定できない拒否。ここで `unknown` 行を
    // 書くと、admin console の Audit Log に **どのテナントのものでもない** 行が並ぶ。human 側の
    // 拒否 (上の describe) が `tenantId: "unknown"` を書くのとは意図的に非対称にしてある:
    // human は自テナントのコンソールから来ていることが判っているが、machine は判っていない。
    const res = await appWithMachineDenial(undefined).request(
      "/deployments/01H8XGJWBWBAQ4N6RZHM4S2KMV",
      { method: "DELETE" },
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(await res.json()).toMatchObject({ error: "forbidden_machine_route" });
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});
