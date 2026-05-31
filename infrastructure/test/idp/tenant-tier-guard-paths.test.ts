import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1418: tenant-template/handlers/idp-handler/tier-guard.ts は 50% branch だった。 既存
 * test は non-silo(503) / non-admin(403) を見るが、 silo + admin の missing-tenant(403) / success
 * 経路 (49-55) が未カバー。 auth (isTenantAdmin / resolveTenantId) を mock して 4 分岐を pin する。
 */
const mocks = vi.hoisted(() => ({ isTenantAdmin: vi.fn(), resolveTenantId: vi.fn() }));
vi.mock("../../lib/control-plane/handlers/idp-handler/auth", () => ({
  isTenantAdmin: mocks.isTenantAdmin,
  resolveTenantId: mocks.resolveTenantId,
}));

const { createTenantIdpResolveScope } = await import(
  "../../lib/tenant-template/handlers/idp-handler/tier-guard"
);

// minimal Context: only c.json is used by the guard.
const ctx = () =>
  ({ json: (body: unknown, status: number) => ({ body, status }) }) as unknown as Context;

afterEach(() => vi.clearAllMocks());

describe("createTenantIdpResolveScope", () => {
  it("should 503 when the tier guard is not 'silo'", () => {
    const out = createTenantIdpResolveScope("pooled")(ctx());
    expect(out).toMatchObject({ forbidden: { status: StatusCodes.SERVICE_UNAVAILABLE } });
    // auth is never consulted on the pooled path.
    expect(mocks.isTenantAdmin).not.toHaveBeenCalled();
  });

  it("should 503 when the tier guard is undefined (fail-closed)", () => {
    const out = createTenantIdpResolveScope(undefined)(ctx());
    expect(out).toMatchObject({ forbidden: { status: StatusCodes.SERVICE_UNAVAILABLE } });
  });

  it("should 403 forbidden for a non-tenant-admin on a silo deployment", () => {
    mocks.isTenantAdmin.mockReturnValue(false);
    const out = createTenantIdpResolveScope("silo")(ctx());
    expect(out).toMatchObject({
      forbidden: { status: StatusCodes.FORBIDDEN, body: { error: "forbidden" } },
    });
  });

  it("should 403 forbidden_missing_tenant when the tenant claim is absent", () => {
    mocks.isTenantAdmin.mockReturnValue(true);
    mocks.resolveTenantId.mockReturnValue(undefined);
    const out = createTenantIdpResolveScope("silo")(ctx());
    expect(out).toMatchObject({
      forbidden: { status: StatusCodes.FORBIDDEN, body: { error: "forbidden_missing_tenant" } },
    });
  });

  it("should resolve a tenant scope for a silo tenant admin", () => {
    mocks.isTenantAdmin.mockReturnValue(true);
    mocks.resolveTenantId.mockReturnValue("tenant-9");
    const out = createTenantIdpResolveScope("silo")(ctx());
    expect(out).toEqual({ kind: "tenant", tenantId: "tenant-9" });
  });
});
