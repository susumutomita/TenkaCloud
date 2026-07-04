import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppEnvironment } from "../src/types.js";

const ROLES_CLAIM = "https://tenkacloud.dev/roles";
const SYSTEM_TOKEN = "system-admin-token-0123456789abcdef";
const envWithToken = { ...env, SYSTEM_ADMIN_TOKEN: SYSTEM_TOKEN };

/** App whose organizer JWT is faked, so the seeded projection can be read back through /v1/admin. */
function appWithOrganizer(payload: unknown) {
  return createApp({
    organizerJwt: createMiddleware<AppEnvironment>(async (context, next) => {
      context.set("jwtPayload", payload);
      await next();
    }),
  });
}

async function put(
  orgId: string,
  body: unknown,
  token?: string,
  app = createApp(),
): Promise<Response> {
  return await app.request(
    `https://control.example/v1/system/tenant-auth-projections/${orgId}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    envWithToken,
  );
}

async function projection(orgId: string) {
  return env.CONTROL_DB.prepare(
    "SELECT tenant_id, suspended FROM tenant_auth_projection WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ tenant_id: string; suspended: number }>();
}

beforeEach(async () => {
  await env.CONTROL_DB.exec("DELETE FROM tenant_auth_projection; DELETE FROM events;");
});

describe("PUT /v1/system/tenant-auth-projections/:orgId (#2364)", () => {
  it("should upsert the projection with a valid system-admin bearer", async () => {
    const res = await put("org_acme", { tenantId: "tenant-acme" }, SYSTEM_TOKEN);
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    expect(await projection("org_acme")).toEqual({ tenant_id: "tenant-acme", suspended: 0 });
  });

  it("should make an organizer for that org resolvable (onboarding gap closed)", async () => {
    await put("org_acme", { tenantId: "tenant-acme" }, SYSTEM_TOKEN);
    const app = appWithOrganizer({
      sub: "auth0|op",
      org_id: "org_acme",
      [ROLES_CLAIM]: ["TenantAdmin"],
    });
    const res = await app.request(
      "https://control.example/v1/admin/events",
      undefined,
      envWithToken,
    );
    expect(res.status).toBe(StatusCodes.OK);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it("should update tenantId and suspension on a second upsert", async () => {
    await put("org_acme", { tenantId: "tenant-one" }, SYSTEM_TOKEN);
    await put("org_acme", { tenantId: "tenant-two", suspended: true }, SYSTEM_TOKEN);
    expect(await projection("org_acme")).toEqual({ tenant_id: "tenant-two", suspended: 1 });
  });

  it("should revoke access immediately when suspended is true", async () => {
    await put("org_acme", { tenantId: "tenant-acme", suspended: true }, SYSTEM_TOKEN);
    const app = appWithOrganizer({
      sub: "auth0|op",
      org_id: "org_acme",
      [ROLES_CLAIM]: ["TenantAdmin"],
    });
    const res = await app.request(
      "https://control.example/v1/admin/events",
      undefined,
      envWithToken,
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    await expect(res.json()).resolves.toEqual({ error: "tenant is suspended" });
  });

  it("should reject a missing or wrong bearer with 401", async () => {
    expect((await put("org_acme", { tenantId: "t" })).status).toBe(StatusCodes.UNAUTHORIZED);
    expect((await put("org_acme", { tenantId: "t" }, "wrong-token")).status).toBe(
      StatusCodes.UNAUTHORIZED,
    );
    expect(await projection("org_acme")).toBeNull();
  });

  it("should return 500 (not 401) when the SYSTEM_ADMIN_TOKEN binding is absent", async () => {
    const res = await createApp().request(
      "https://control.example/v1/system/tenant-auth-projections/org_acme",
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${SYSTEM_TOKEN}` },
        body: JSON.stringify({ tenantId: "tenant-acme" }),
      },
      env,
    );
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    await expect(res.json()).resolves.toEqual({ error: "internal server error" });
  });

  it("should reject a body without tenantId and a non-boolean suspended with 400", async () => {
    expect((await put("org_acme", {}, SYSTEM_TOKEN)).status).toBe(StatusCodes.BAD_REQUEST);
    expect((await put("org_acme", { tenantId: "t", suspended: "yes" }, SYSTEM_TOKEN)).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });

  it("should reject a whitespace-only orgId with 400", async () => {
    // %20 decodes to a space; the handler trims and rejects an empty org id.
    expect((await put("%20", { tenantId: "t" }, SYSTEM_TOKEN)).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
});
