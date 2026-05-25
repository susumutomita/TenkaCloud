import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import {
  isSystemAdmin,
  isTenantAdmin,
  resolveCognitoSub,
  resolveTenantId,
} from "../../lib/control-plane/handlers/idp-handler/auth";

function ctx(claims?: Record<string, unknown>): Context {
  return {
    env: {
      event: claims ? { requestContext: { authorizer: { jwt: { claims } } } } : undefined,
    },
  } as unknown as Context;
}

describe("isSystemAdmin", () => {
  it("should be true only when custom:userRole === SystemAdmin", () => {
    expect(isSystemAdmin(ctx({ "custom:userRole": "SystemAdmin" }))).toBe(true);
    expect(isSystemAdmin(ctx({ "custom:userRole": "TenantAdmin" }))).toBe(false);
    expect(isSystemAdmin(ctx({ "custom:userRole": "" }))).toBe(false);
    expect(isSystemAdmin(ctx())).toBe(false);
  });
});

describe("isTenantAdmin", () => {
  it("should be true only when custom:userRole === TenantAdmin", () => {
    expect(isTenantAdmin(ctx({ "custom:userRole": "TenantAdmin" }))).toBe(true);
    expect(isTenantAdmin(ctx({ "custom:userRole": "SystemAdmin" }))).toBe(false);
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
});

describe("resolveCognitoSub", () => {
  it("should return the sub claim or 'unknown'", () => {
    expect(resolveCognitoSub(ctx({ sub: "u-1" }))).toBe("u-1");
    expect(resolveCognitoSub(ctx())).toBe("unknown");
  });
});
