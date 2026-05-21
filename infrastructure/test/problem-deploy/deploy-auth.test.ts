import type { Context } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractClaims,
  extractTenantIdFromClaims,
  extractUserRoleFromClaims,
  ForbiddenRoleError,
  MissingTenantClaimError,
  requireRole,
  requireTenantAdmin,
  resolveCognitoSub,
  resolveTenantId,
  resolveUserRole,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
  TENANT_ROLES,
  TENANT_VIEWER_ROLE,
} from "../../lib/problem-deploy/handlers/deploy-handler/auth";

describe("extractTenantIdFromClaims", () => {
  it("should return custom:tenantId when it is a string", () => {
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

  it("should trim and return (guard against Cognito trailing-space drift)", () => {
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

  it("should prefer the JWT claim when present", () => {
    process.env.DEFAULT_TENANT_ID = "tenant-from-env";
    const c = buildCtx({ "custom:tenantId": "tenant-from-jwt" });
    expect(resolveTenantId(c)).toBe("tenant-from-jwt");
  });

  it("should fall back to DEFAULT_TENANT_ID env when JWT claim is missing", () => {
    process.env.DEFAULT_TENANT_ID = "tenant-from-env";
    const c = buildCtx();
    expect(resolveTenantId(c)).toBe("tenant-from-env");
  });

  it("should throw MissingTenantClaimError when env is also missing (Issue #843 fail-closed)", () => {
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
  it("should return custom:userRole trimmed when it is a string", () => {
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

  it("should prefer the JWT claim when present", () => {
    process.env.DEFAULT_USER_ROLE = "from-env";
    const c = buildCtx({ "custom:userRole": "TenantAdmin" });
    expect(resolveUserRole(c)).toBe("TenantAdmin");
  });

  it("should fall back to DEFAULT_USER_ROLE env when JWT claim is missing", () => {
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    expect(resolveUserRole(buildCtx())).toBe("TenantAdmin");
  });

  it("should return undefined when env is also missing", () => {
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

/* ---- REST API + CognitoUserPoolsAuthorizer の claim path ---- */
// tenant API は `RestApi` + `CognitoUserPoolsAuthorizer`、 admin-insight 等は HTTP API +
// JWT Authorizer。 REST API は `event.requestContext.authorizer.claims` (= .jwt. wrap 無し)、
// HTTP API は `event.requestContext.authorizer.jwt.claims`。 auth helper は両方を見るべき。

function buildRestCtx(claims?: Record<string, string>): Context {
  return {
    env: {
      event: {
        requestContext: claims ? { authorizer: { claims } } : {},
      },
    },
  } as unknown as Context;
}

describe("extractClaims (REST API vs HTTP API authorizer 形式)", () => {
  it("should read HTTP API V2 form (authorizer.jwt.claims)", () => {
    const c = buildCtx({ "custom:tenantId": "tenant-http-api" });
    expect(extractClaims(c)).toEqual({ "custom:tenantId": "tenant-http-api" });
  });

  it("should read the REST API + Cognito form (authorizer.claims, no .jwt. wrap)", () => {
    const c = buildRestCtx({ "custom:tenantId": "tenant-rest-api" });
    expect(extractClaims(c)).toEqual({ "custom:tenantId": "tenant-rest-api" });
  });

  it("authorizer が無いなら undefined", () => {
    const c = { env: { event: { requestContext: {} } } } as unknown as Context;
    expect(extractClaims(c)).toBeUndefined();
  });
});

/* ---- ADR-020 / Issue #926 Phase B: role enum + requireRole ---- */

describe("TENANT_ROLES enum (ADR-020)", () => {
  it("should have 3 roles (Admin / Operator / Viewer)", () => {
    expect(TENANT_ROLES).toEqual(["TenantAdmin", "TenantOperator", "TenantViewer"]);
  });

  it("const exports should match the role strings", () => {
    expect(TENANT_ADMIN_ROLE).toBe("TenantAdmin");
    expect(TENANT_OPERATOR_ROLE).toBe("TenantOperator");
    expect(TENANT_VIEWER_ROLE).toBe("TenantViewer");
  });
});

describe("requireRole (ADR-020 / #926 Phase B)", () => {
  const original = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = original;
  });

  it("allowedRoles に含まれる role なら throw しない", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantOperator" });
    expect(() => requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE])).not.toThrow();
  });

  it("allowedRoles に含まれない role なら ForbiddenRoleError を throw", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantViewer" });
    expect(() => requireRole(c, [TENANT_ADMIN_ROLE])).toThrow(ForbiddenRoleError);
  });

  it("allowedRoles 空配列は always reject (= 設定ミスを fail-closed に倒す)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantAdmin" });
    expect(() => requireRole(c, [])).toThrow(ForbiddenRoleError);
  });

  it("claim 不在 / env も無いなら ForbiddenRoleError を throw (= fail-closed)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    expect(() => requireRole(buildCtx(), [TENANT_VIEWER_ROLE])).toThrow(ForbiddenRoleError);
  });

  it("ForbiddenRoleError に actualRole / requiredRoles を保持する", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantViewer" });
    try {
      requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
      expect.fail("should have thrown");
    } catch (err) {
      const forbidden = err as ForbiddenRoleError;
      expect(forbidden.actualRole).toBe("TenantViewer");
      expect(forbidden.requiredRoles).toEqual([TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
    }
  });
});

describe("requireTenantAdmin alias (= requireRole(c, [TENANT_ADMIN_ROLE]))", () => {
  const original = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = original;
  });

  it("TenantOperator should be rejected by requireTenantAdmin (Phase B alias does not degrade)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantOperator" });
    expect(() => requireTenantAdmin(c)).toThrow(ForbiddenRoleError);
  });

  it("TenantViewer も同様に reject", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildCtx({ "custom:userRole": "TenantViewer" });
    expect(() => requireTenantAdmin(c)).toThrow(ForbiddenRoleError);
  });
});

describe("resolveTenantId / resolveUserRole / resolveCognitoSub (REST API path)", () => {
  const originalTenant = process.env.DEFAULT_TENANT_ID;
  const originalRole = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (originalTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
    else process.env.DEFAULT_TENANT_ID = originalTenant;
    if (originalRole === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = originalRole;
  });

  it("should resolve tenantId from the REST API claim path", () => {
    delete process.env.DEFAULT_TENANT_ID;
    const c = buildRestCtx({ "custom:tenantId": "tenant-rest-api" });
    expect(resolveTenantId(c)).toBe("tenant-rest-api");
  });

  it("should resolve userRole from the REST API claim path (Issue #903 forbidden_role fix)", () => {
    delete process.env.DEFAULT_USER_ROLE;
    const c = buildRestCtx({ "custom:userRole": "TenantAdmin" });
    expect(resolveUserRole(c)).toBe("TenantAdmin");
    expect(() => requireTenantAdmin(c)).not.toThrow();
  });

  it("should resolve Cognito sub from the REST API claim path", () => {
    const c = buildRestCtx({ sub: "user-rest-api" });
    expect(resolveCognitoSub(c)).toBe("user-rest-api");
  });
});
