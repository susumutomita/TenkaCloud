import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { isTenantAdmin, resolveCognitoSub, resolveTenantId } from "../../lib/shared/idp/auth";

function ctx(claims?: Record<string, unknown>): Context {
  return {
    env: {
      event: claims ? { requestContext: { authorizer: { jwt: { claims } } } } : undefined,
    },
  } as unknown as Context;
}

function restApiCtx(claims?: Record<string, unknown>): Context {
  return {
    env: {
      event: claims ? { requestContext: { authorizer: { claims } } } : undefined,
    },
  } as unknown as Context;
}

describe("isTenantAdmin", () => {
  it("should be true only when custom:userRole === TenantAdmin", () => {
    expect(isTenantAdmin(ctx({ "custom:userRole": "TenantAdmin" }))).toBe(true);
    expect(isTenantAdmin(ctx({ "custom:userRole": "SystemAdmin" }))).toBe(false);
    expect(isTenantAdmin(ctx({ "custom:userRole": "" }))).toBe(false);
    expect(isTenantAdmin(ctx())).toBe(false);
  });

  it("should read custom:userRole from the REST API Cognito authorizer claims path", () => {
    expect(isTenantAdmin(restApiCtx({ "custom:userRole": "TenantAdmin" }))).toBe(true);
  });
});

describe("resolveTenantId", () => {
  it("should return the custom:tenantId claim when present and non-empty", () => {
    expect(resolveTenantId(ctx({ "custom:tenantId": "acme" }))).toBe("acme");
  });
  it("should return undefined when claim is missing or empty", () => {
    expect(resolveTenantId(ctx({ "custom:tenantId": "" }))).toBeUndefined();
    expect(resolveTenantId(ctx())).toBeUndefined();
  });
  it("should read custom:tenantId from the REST API Cognito authorizer claims path", () => {
    expect(resolveTenantId(restApiCtx({ "custom:tenantId": "lite-local" }))).toBe("lite-local");
  });
});

describe("resolveCognitoSub", () => {
  it("should return the sub claim or 'unknown'", () => {
    expect(resolveCognitoSub(ctx({ sub: "u-1" }))).toBe("u-1");
    expect(resolveCognitoSub(ctx())).toBe("unknown");
  });
});
