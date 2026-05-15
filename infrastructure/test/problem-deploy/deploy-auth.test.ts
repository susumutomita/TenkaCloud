import type { Context } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractTenantIdFromClaims,
  MissingTenantClaimError,
  resolveTenantId,
} from "../../lib/problem-deploy/handlers/deploy-handler/auth";

describe("extractTenantIdFromClaims", () => {
  it("custom:tenantId が文字列なら返すべき", () => {
    expect(extractTenantIdFromClaims({ "custom:tenantId": "tenant-acme" })).toBe("tenant-acme");
  });

  it("空文字 / 空白のみは undefined", () => {
    expect(extractTenantIdFromClaims({ "custom:tenantId": "" })).toBeUndefined();
    expect(extractTenantIdFromClaims({ "custom:tenantId": "   " })).toBeUndefined();
  });

  it("数値 / boolean / 配列は (string でないので) 拒否", () => {
    expect(extractTenantIdFromClaims({ "custom:tenantId": 42 })).toBeUndefined();
    expect(extractTenantIdFromClaims({ "custom:tenantId": true })).toBeUndefined();
    expect(extractTenantIdFromClaims({ "custom:tenantId": ["tenant-acme"] })).toBeUndefined();
  });

  it("claims 自体が undefined なら undefined", () => {
    expect(extractTenantIdFromClaims(undefined)).toBeUndefined();
  });

  it("custom:tenantId キーが無ければ undefined", () => {
    expect(extractTenantIdFromClaims({ sub: "u-1" })).toBeUndefined();
  });

  it("trim して返すべき (Cognito の trailing space 揺れ対策)", () => {
    expect(extractTenantIdFromClaims({ "custom:tenantId": "  tenant-acme  " })).toBe("tenant-acme");
  });
});

function buildCtx(claims?: Record<string, string>): Context {
  return {
    env: {
      event: {
        requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
      },
    },
  } as unknown as Context;
}

describe("resolveTenantId", () => {
  const original = process.env.DEFAULT_TENANT_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_TENANT_ID;
    else process.env.DEFAULT_TENANT_ID = original;
  });

  it("JWT claim が居れば優先するべき", () => {
    process.env.DEFAULT_TENANT_ID = "tenant-from-env";
    const c = buildCtx({ "custom:tenantId": "tenant-from-jwt" });
    expect(resolveTenantId(c)).toBe("tenant-from-jwt");
  });

  it("JWT claim が無ければ DEFAULT_TENANT_ID env を返すべき", () => {
    process.env.DEFAULT_TENANT_ID = "tenant-from-env";
    const c = buildCtx();
    expect(resolveTenantId(c)).toBe("tenant-from-env");
  });

  it("env も無ければ MissingTenantClaimError を throw すべき (= Issue #843 fail-closed)", () => {
    delete process.env.DEFAULT_TENANT_ID;
    const c = buildCtx();
    expect(() => resolveTenantId(c)).toThrow(MissingTenantClaimError);
  });

  it("requestContext が存在しない (Function URL ops 経路) なら env にフォールバック", () => {
    process.env.DEFAULT_TENANT_ID = "tenant-from-env";
    const c = { env: {} } as unknown as Context;
    expect(resolveTenantId(c)).toBe("tenant-from-env");
  });
});
