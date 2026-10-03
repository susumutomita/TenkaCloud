import { Hono } from "hono";
import { cors } from "hono/cors";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ForbiddenRoleError,
  MissingTenantClaimError,
  TENANT_ROLES,
  TenantSuspendedError,
} from "../../lib/problem-deploy/handlers/deploy-handler/auth";
import {
  buildAuthErrorHandler,
  createRoleCheckMiddleware,
} from "../../lib/problem-deploy/handlers/shared/auth-wiring";

/**
 * Issue (#1937 simplify pass): the deploy-handler and event-handler shared a
 * byte-identical `app.onError` auth-error mapping and a healthz-skipping role-check
 * middleware. Both are now built by `buildAuthErrorHandler` / `createRoleCheckMiddleware`.
 * This test pins the factory output: each error class maps to its status, the generic
 * fall-through is 500 with no leaked `message`, CORS headers still attach on the error
 * path, and `/healthz` bypasses the role check while every other path enforces it.
 */

// Silence the auth-warning log lines (the handler warns on 401/403); we assert on errorSpy.
vi.spyOn(console, "warn").mockImplementation(() => undefined);
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => {
  vi.clearAllMocks();
});

/** A throwing route exercises onError without going through a handler try/catch. */
function appThatThrows(err: unknown, logPrefix: string): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 600 }));
  app.onError(buildAuthErrorHandler({ logPrefix }));
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

describe("buildAuthErrorHandler", () => {
  it("should map MissingTenantClaimError to 401 with the missing_tenant_claim code", async () => {
    const res = await appThatThrows(new MissingTenantClaimError(), "[deploy]").request("/boom");
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect((await res.json()).error).toBe("missing_tenant_claim");
  });

  it("should map ForbiddenRoleError to 403 with the forbidden_role code", async () => {
    const res = await appThatThrows(
      new ForbiddenRoleError("TenantUser", TENANT_ROLES),
      "[events]",
    ).request("/boom");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_role");
  });

  it("should map TenantSuspendedError to 403 with the tenant_suspended code", async () => {
    const res = await appThatThrows(new TenantSuspendedError(), "[deploy]").request("/boom");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("tenant_suspended");
  });

  it("should map an arbitrary Error to 500 internal_error without leaking the message", async () => {
    const res = await appThatThrows(new Error("secret IAM ARN"), "[events]").request("/boom");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBeUndefined();
  });

  it("should map a non-Error value to 500 internal_error ('unknown error' branch)", async () => {
    // Hono only routes Error instances through onError, so the non-Error branch is
    // exercised by invoking the handler directly with a minimal Context (= the same shape
    // the handler reads: req.path / req.method / json()).
    const handler = buildAuthErrorHandler({ logPrefix: "[deploy]" });
    const json = vi.fn(
      (body: unknown, status: number) => ({ body, status }) as unknown as Response,
    );
    const fakeCtx = { req: { path: "/x", method: "GET" }, json } as unknown as Parameters<
      typeof handler
    >[1];
    // biome-ignore lint/suspicious/noExplicitAny: the branch under test accepts non-Error values.
    await handler("plain string fail" as any, fakeCtx);
    expect(json).toHaveBeenCalledWith(
      { error: "internal_error" },
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[deploy] uncaught handler error",
      expect.objectContaining({ message: "unknown error" }),
    );
  });

  it("should attach CORS headers on the error path so the browser can read the body", async () => {
    const res = await appThatThrows(new Error("boom"), "[deploy]").request("/boom");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("should log with the supplied logPrefix", async () => {
    await appThatThrows(new Error("boom"), "[events]").request("/boom");
    expect(errorSpy).toHaveBeenCalledWith(
      "[events] uncaught handler error",
      expect.objectContaining({ message: "boom" }),
    );
  });
});

describe("createRoleCheckMiddleware", () => {
  const ORIGINAL_ROLE = process.env.DEFAULT_USER_ROLE;
  beforeEach(() => {
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  });
  afterEach(() => {
    if (ORIGINAL_ROLE === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = ORIGINAL_ROLE;
  });

  /** Build a Hono app guarded by the middleware, with a healthz + a protected route. */
  function guardedApp(mountPath: string): Hono {
    const app = new Hono();
    app.onError(buildAuthErrorHandler({ logPrefix: "[test]" }));
    app.use(mountPath, createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_ROLES }));
    app.get("/svc/healthz", (c) => c.json({ ok: true }));
    app.get("/svc/protected", (c) => c.json({ ok: true }));
    return app;
  }

  it("should bypass the role check on a /healthz path even when the role would 403", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser"; // not in TENANT_ROLES
    const res = await guardedApp("*").request("/svc/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("should enforce the role check on a non-healthz path (200 for a tenant role)", async () => {
    const res = await guardedApp("*").request("/svc/protected");
    expect(res.status).toBe(StatusCodes.OK);
  });

  it("should 403 forbidden_role on a non-tenant role for a protected path", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser";
    const res = await guardedApp("*").request("/svc/protected");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_role");
  });

  it("should only guard paths under the mount prefix (event-handler /events/* shape)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser";
    const app = new Hono();
    app.onError(buildAuthErrorHandler({ logPrefix: "[test]" }));
    app.use("/svc/*", createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_ROLES }));
    app.get("/svc/protected", (c) => c.json({ ok: true }));
    app.get("/outside", (c) => c.json({ ok: true }));
    // /outside is outside the mount prefix, so the middleware never runs.
    expect((await app.request("/outside")).status).toBe(StatusCodes.OK);
    // /svc/protected is guarded → 403 for a non-tenant role.
    expect((await app.request("/svc/protected")).status).toBe(StatusCodes.FORBIDDEN);
  });
});
