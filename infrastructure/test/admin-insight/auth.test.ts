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
  it("cognito:groups が string[] で SystemAdmin を含むなら true", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": ["SystemAdmin"] }))).toBe(true);
  });

  it("cognito:groups が string[] で SystemAdmin を含まないなら false", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": ["TenantAdmin"] }))).toBe(false);
  });

  it("cognito:groups が string で `[SystemAdmin]` 形式でも true", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": "[SystemAdmin]" }))).toBe(true);
  });

  it("cognito:groups が string で comma 区切りに SystemAdmin が混じるなら true", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": "Foo,SystemAdmin,Bar" }))).toBe(true);
  });

  it("cognito:groups が string で SystemAdmin を含まないなら false", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": "TenantAdmin" }))).toBe(false);
  });

  it("claim が無いなら false", () => {
    expect(isSystemAdmin(buildContext())).toBe(false);
    expect(isSystemAdmin(buildContext({}))).toBe(false);
  });

  it("cognito:groups が未知 type (例: number) なら false", () => {
    expect(isSystemAdmin(buildContext({ "cognito:groups": 42 }))).toBe(false);
  });
});

describe("resolveCognitoSub", () => {
  it("sub claim があればその文字列を返すべき", () => {
    expect(resolveCognitoSub(buildContext({ sub: "abc-123" }))).toBe("abc-123");
  });

  it("sub が無いなら 'unknown' を返すべき", () => {
    expect(resolveCognitoSub(buildContext())).toBe("unknown");
    expect(resolveCognitoSub(buildContext({}))).toBe("unknown");
  });

  it("sub が空文字なら 'unknown' を返すべき", () => {
    expect(resolveCognitoSub(buildContext({ sub: "" }))).toBe("unknown");
  });
});
