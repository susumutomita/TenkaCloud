import type { Context } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractTenantIdFromClaims,
  extractUserRoleFromClaims,
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireTenantAdmin,
  resolveTenantId,
  resolveUserRole,
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

/* ---- Issue #854: TenantAdmin role enforcement ---- */

describe("extractUserRoleFromClaims (Issue #854)", () => {
  it("custom:userRole が文字列なら trim して返すべき", () => {
    expect(extractUserRoleFromClaims({ "custom:userRole": "TenantAdmin" })).toBe("TenantAdmin");
    expect(extractUserRoleFromClaims({ "custom:userRole": "  TenantAdmin  " })).toBe("TenantAdmin");
  });

  it("不在 / 空 / 非 string は undefined", () => {
    expect(extractUserRoleFromClaims({})).toBeUndefined();
    expect(extractUserRoleFromClaims({ "custom:userRole": "" })).toBeUndefined();
    expect(extractUserRoleFromClaims({ "custom:userRole": 42 })).toBeUndefined();
    expect(extractUserRoleFromClaims(undefined)).toBeUndefined();
  });
});

describe("resolveUserRole (Issue #854)", () => {
  const original = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = original;
  });

  it("JWT claim が居れば優先するべき", () => {
    process.env.DEFAULT_USER_ROLE = "from-env";
    const c = buildCtx({ "custom:userRole": "TenantAdmin" });
    expect(resolveUserRole(c)).toBe("TenantAdmin");
  });

  it("JWT claim が無ければ DEFAULT_USER_ROLE env を返すべき", () => {
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    expect(resolveUserRole(buildCtx())).toBe("TenantAdmin");
  });

  it("env も無ければ undefined を返すべき", () => {
    delete process.env.DEFAULT_USER_ROLE;
    expect(resolveUserRole(buildCtx())).toBeUndefined();
  });
});

describe("requireTenantAdmin (Issue #854)", () => {
  const original = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = original;
  });

  it("TenantAdmin role なら throw せずに pass", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantAdmin" });
    expect(() => requireTenantAdmin(c)).not.toThrow();
  });

  it("他 role (= TenantUser / Auditor 等) なら ForbiddenRoleError を throw", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantUser" });
    expect(() => requireTenantAdmin(c)).toThrow(ForbiddenRoleError);
  });

  it("role claim 不在 / env も無いなら ForbiddenRoleError を throw (= fail-closed)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx();
    expect(() => requireTenantAdmin(c)).toThrow(ForbiddenRoleError);
  });

  it("DEFAULT_USER_ROLE=TenantAdmin env で JWT 不在経路 (= test bypass) は pass", () => {
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    expect(() => requireTenantAdmin(buildCtx())).not.toThrow();
  });

  it("ForbiddenRoleError は actualRole / requiredRoles を保持する (= audit log 用)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantUser" });
    try {
      requireTenantAdmin(c);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenRoleError);
      const forbidden = err as ForbiddenRoleError;
      expect(forbidden.actualRole).toBe("TenantUser");
      expect(forbidden.requiredRoles).toEqual(["TenantAdmin"]);
    }
  });
});
