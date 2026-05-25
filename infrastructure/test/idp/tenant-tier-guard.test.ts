import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Defense-in-depth tier guard for the Application Plane IdP CRUD Lambda.
 *
 * The UI hides IdP CRUD for pooled tenants, but a TenantAdmin with a valid
 * JWT could bypass the SPA and call this API directly. In a pooled UserPool
 * that would mutate the SHARED UserPool's federated IdPs — cross-tenant
 * data-plane impact.
 *
 * This test pins the env-var-based fail-closed contract: without
 * `IDP_TIER_GUARD=silo` the handler returns 503 for every request.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.SAML_IDPS_TABLE_NAME = "TestSamlIdps";
  process.env.TENANT_USER_POOL_ID = "us-east-1_TEST";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadAppWithGuard(value: string | undefined): Promise<{
  readonly app: { fetch: (req: Request) => Promise<Response> };
}> {
  if (value === undefined) {
    delete process.env.IDP_TIER_GUARD;
  } else {
    process.env.IDP_TIER_GUARD = value;
  }
  const mod = await import("../../lib/tenant-template/handlers/idp-handler/index.ts");
  return { app: mod.app as { fetch: (req: Request) => Promise<Response> } };
}

function buildAuthedRequest(): Request {
  // The JWT decode happens inside the Lambda authorizer (= API GW), so a
  // synthetic Authorization header is enough for the handler to reach the
  // `resolveScope` callback.
  return new Request("http://localhost/tenant/idp", {
    method: "GET",
    headers: { authorization: "Bearer test-jwt" },
  });
}

describe("Application Plane IdP handler tier guard", () => {
  it("should return 503 when IDP_TIER_GUARD env is absent (pooled-tier default)", async () => {
    const { app } = await loadAppWithGuard(undefined);
    const res = await app.fetch(buildAuthedRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tenant_tier_not_silo");
  });

  it("should return 503 when IDP_TIER_GUARD is any value other than 'silo'", async () => {
    const { app } = await loadAppWithGuard("pooled");
    const res = await app.fetch(buildAuthedRequest());
    expect(res.status).toBe(503);
  });

  it("should fall through to auth check when IDP_TIER_GUARD=silo (no longer 503)", async () => {
    const { app } = await loadAppWithGuard("silo");
    const res = await app.fetch(buildAuthedRequest());
    // With the guard cleared but no valid JWT, the auth layer rejects.
    // The point of THIS test is only that the response is no longer the
    // tier-guard 503. Any non-503 response means we passed the guard.
    expect(res.status).not.toBe(503);
  });
});
