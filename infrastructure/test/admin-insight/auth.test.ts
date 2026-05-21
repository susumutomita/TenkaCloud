import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import {
  isSystemAdmin,
  resolveCognitoSub,
} from "../../lib/admin-insight/handlers/admin-insight-handler/auth";

function buildContext(claims?: Record<string, unknown>): Context {
  return {
    env: {
      event: claims ? { requestContext: { authorizer: { jwt: { claims } } } } : undefined,
    },
  } as unknown as Context;
}

describe("isSystemAdmin", () => {
  it("custom:userRole === 'SystemAdmin' なら true (= SBT が createAdminUser 経由で埋める claim)", () => {
    expect(isSystemAdmin(buildContext({ "custom:userRole": "SystemAdmin" }))).toBe(true);
  });

  it("custom:userRole === 'TenantAdmin' なら false (= Tenant Admin token が誤って届いた case)", () => {
    expect(isSystemAdmin(buildContext({ "custom:userRole": "TenantAdmin" }))).toBe(false);
  });

  it("custom:userRole が大文字小文字違いなら false (= 完全一致以外は SystemAdmin と見なさない)", () => {
    expect(isSystemAdmin(buildContext({ "custom:userRole": "systemadmin" }))).toBe(false);
    expect(isSystemAdmin(buildContext({ "custom:userRole": "SYSTEMADMIN" }))).toBe(false);
  });

  it("should trim leading/trailing whitespace on custom:userRole before evaluation", () => {
    expect(isSystemAdmin(buildContext({ "custom:userRole": "  SystemAdmin  " }))).toBe(true);
  });

  it("claim が無いなら false", () => {
    expect(isSystemAdmin(buildContext())).toBe(false);
    expect(isSystemAdmin(buildContext({}))).toBe(false);
  });

  it("custom:userRole が string 以外 (例: number / array) なら false", () => {
    expect(isSystemAdmin(buildContext({ "custom:userRole": 42 }))).toBe(false);
    expect(isSystemAdmin(buildContext({ "custom:userRole": ["SystemAdmin"] }))).toBe(false);
  });

  it("cognito:groups だけ届いていても custom:userRole が無ければ false (= 旧経路の互換は持たない)", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": ["SystemAdmin"] }))).toBe(false);
  });
});

describe("resolveCognitoSub", () => {
  it("should return the sub claim string when present", () => {
    expect(resolveCognitoSub(buildContext({ sub: "abc-123" }))).toBe("abc-123");
  });

  it("should return 'unknown' when sub is missing", () => {
    expect(resolveCognitoSub(buildContext())).toBe("unknown");
    expect(resolveCognitoSub(buildContext({}))).toBe("unknown");
  });

  it("should return 'unknown' when sub is an empty string", () => {
    expect(resolveCognitoSub(buildContext({ sub: "" }))).toBe("unknown");
  });
});
