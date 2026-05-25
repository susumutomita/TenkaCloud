import { describe, expect, it, vi } from "vitest";
import { createCognitoIdpAdapter } from "../../lib/control-plane/handlers/idp-handler/cognito-adapter.ts";
import type { IdpHandlerDeps } from "../../lib/control-plane/handlers/idp-handler/core.ts";
import { createDdbIdpStore } from "../../lib/control-plane/handlers/idp-handler/ddb-store.ts";
import { buildIdpApp } from "../../lib/control-plane/handlers/idp-handler/routes.ts";
import { createTenantIdpResolveScope } from "../../lib/tenant-template/handlers/idp-handler/tier-guard.ts";

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
 *
 * We exercise `createTenantIdpResolveScope` (the pure factory the Lambda's
 * `index.ts` calls with `process.env.IDP_TIER_GUARD`) by passing the env value
 * as a function argument. This avoids `vi.resetModules()` + dynamic import on
 * the Lambda module (which transitively imports zod and breaks under Bun's
 * ESM module-graph rebuild) and also avoids triggering `requireEnv` for
 * `SAML_IDPS_TABLE_NAME` / `TENANT_USER_POOL_ID` at module load.
 */

function buildTestApp(tierGuard: string | undefined) {
  // Deps are short-circuited by the tier-guard 503 long before any AWS call,
  // so stub clients are safe here. We still need real factory objects to
  // satisfy the IdpHandlerDeps shape.
  const deps: IdpHandlerDeps = {
    store: createDdbIdpStore({
      ddb: { send: vi.fn() } as never,
      tableName: "TestSamlIdps",
    }),
    cognito: createCognitoIdpAdapter({
      client: { send: vi.fn() } as never,
      userPoolId: "us-east-1_TEST",
    }),
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  return buildIdpApp({
    pathPrefix: "/tenant/idp",
    resolveScope: createTenantIdpResolveScope(tierGuard),
    deps,
  });
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
    const app = buildTestApp(undefined);
    const res = await app.fetch(buildAuthedRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tenant_tier_not_silo");
  });

  it("should return 503 when IDP_TIER_GUARD is any value other than 'silo'", async () => {
    const app = buildTestApp("pooled");
    const res = await app.fetch(buildAuthedRequest());
    expect(res.status).toBe(503);
  });

  it("should fall through to auth check when IDP_TIER_GUARD=silo (no longer 503)", async () => {
    const app = buildTestApp("silo");
    const res = await app.fetch(buildAuthedRequest());
    // With the guard cleared but no valid JWT, the auth layer rejects.
    // The point of THIS test is only that the response is no longer the
    // tier-guard 503. Any non-503 response means we passed the guard.
    expect(res.status).not.toBe(503);
  });
});
