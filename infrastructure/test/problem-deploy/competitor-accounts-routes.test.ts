import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// #686: `resolveTenantId` は JWT claim 欠落で MissingTenantClaimError を throw する。
// route tests は `app.request()` で JWT を bypass するため、 dev override env で tenantId を
// inject する。 prod では Cognito JWT が必ず claim を載せる前提なのでこの env は使わない。
beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  // Issue #854: handler middleware が TenantAdmin role を要求するので test 環境では env で inject。
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

const mocks = vi.hoisted(() => ({
  createCompetitorAccount: vi.fn(),
  listCompetitorAccounts: vi.fn(),
  deleteCompetitorAccount: vi.fn(),
  verifyCompetitorAccount: vi.fn(),
  rotateExternalIdForAccount: vi.fn(),
  DuplicateCompetitorAccountError: class extends Error {
    constructor(public readonly awsAccountId: string) {
      super("dup");
      this.name = "DuplicateCompetitorAccountError";
    }
  },
  CompetitorAccountNotFoundError: class extends Error {
    constructor(public readonly awsAccountId: string) {
      super("404");
      this.name = "CompetitorAccountNotFoundError";
    }
  },
  ExternalIdMissingForRotationError: class extends Error {
    constructor(public readonly tenantId: string) {
      super("missing");
      this.name = "ExternalIdMissingForRotationError";
    }
  },
  CompetitorAccountNotVerifiedError: class extends Error {
    constructor(public readonly awsAccountId: string) {
      super("not verified");
      this.name = "CompetitorAccountNotVerifiedError";
    }
  },
  AssumeRoleSanityCheckFailedError: class extends Error {
    constructor(
      public readonly awsAccountId: string,
      public readonly underlyingErrorName: string,
      message: string,
    ) {
      super(message);
      this.name = "AssumeRoleSanityCheckFailedError";
    }
  },
  ExternalIdMissingError: class extends Error {
    constructor(public readonly tenantId: string) {
      super("missing");
      this.name = "ExternalIdMissingError";
    }
  },
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/shared", () => ({
  buildCompetitorAccountsSharedResources: () => ({
    tableName: "TestCompetitorAccounts",
    env: "development",
    tenkaCloudAccountId: "111111111111",
    ddb: { send: vi.fn() },
    ssm: { send: vi.fn() },
    sts: { send: vi.fn() },
  }),
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/store", () => ({
  createCompetitorAccount: mocks.createCompetitorAccount,
  listCompetitorAccounts: mocks.listCompetitorAccounts,
  deleteCompetitorAccount: mocks.deleteCompetitorAccount,
  rotateExternalIdForAccount: mocks.rotateExternalIdForAccount,
  DuplicateCompetitorAccountError: mocks.DuplicateCompetitorAccountError,
  CompetitorAccountNotFoundError: mocks.CompetitorAccountNotFoundError,
  CompetitorAccountNotVerifiedError: mocks.CompetitorAccountNotVerifiedError,
  ExternalIdMissingForRotationError: mocks.ExternalIdMissingForRotationError,
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/verify", () => ({
  verifyCompetitorAccount: mocks.verifyCompetitorAccount,
  AssumeRoleSanityCheckFailedError: mocks.AssumeRoleSanityCheckFailedError,
  ExternalIdMissingError: mocks.ExternalIdMissingError,
}));

const { app } = await import("../../lib/problem-deploy/handlers/competitor-accounts-handler/index");

describe("POST /admin/competitor-accounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 201 with body containing externalId / tenkaCloudAccountId", async () => {
    mocks.createCompetitorAccount.mockResolvedValueOnce({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: false,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
      externalId: "abc123",
      tenkaCloudAccountId: "111111111111",
    });
    const res = await app.request("/admin/competitor-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      }),
    });
    expect(res.status).toBe(StatusCodes.CREATED);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.externalId).toBe("abc123");
    expect(body.tenkaCloudAccountId).toBe("111111111111");
    expect(body.verified).toBe(false);
  });

  it("should return 400 on validation failure (awsAccountId not 12 digits)", async () => {
    const res = await app.request("/admin/competitor-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ awsAccountId: "abc" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.createCompetitorAccount).not.toHaveBeenCalled();
  });

  it("should return 409 on Duplicate", async () => {
    mocks.createCompetitorAccount.mockRejectedValueOnce(
      new mocks.DuplicateCompetitorAccountError("222222222222"),
    );
    const res = await app.request("/admin/competitor-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      }),
    });
    expect(res.status).toBe(StatusCodes.CONFLICT);
  });
});

describe("GET /admin/competitor-accounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return the listing (mixed verified) without including externalId", async () => {
    mocks.listCompetitorAccounts.mockResolvedValueOnce([
      {
        awsAccountId: "222222222222",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: true,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z",
      },
      {
        awsAccountId: "333333333333",
        region: "ap-northeast-1",
        competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
        verified: false,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z",
      },
    ]);
    const res = await app.request("/admin/competitor-accounts");
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).not.toHaveProperty("externalId");
  });
});

describe("POST /admin/competitor-accounts/:awsAccountId/verify", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 200 + verified=true on STS success", async () => {
    mocks.verifyCompetitorAccount.mockResolvedValueOnce({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      verifiedAt: "2026-05-11T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    });
    const res = await app.request("/admin/competitor-accounts/222222222222/verify", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
  });

  it("should return 422 + underlyingErrorName when STS AssumeRole fails", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(
      new mocks.AssumeRoleSanityCheckFailedError("222222222222", "AccessDenied", "denied"),
    );
    const res = await app.request("/admin/competitor-accounts/222222222222/verify", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.underlyingErrorName).toBe("AccessDenied");
  });

  it("should return 404 when there is no row", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(
      new mocks.CompetitorAccountNotFoundError("999999999999"),
    );
    const res = await app.request("/admin/competitor-accounts/999999999999/verify", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("awsAccountId が 12 桁でないと 400", async () => {
    const res = await app.request("/admin/competitor-accounts/abc/verify", { method: "POST" });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.verifyCompetitorAccount).not.toHaveBeenCalled();
  });
});

// Issue #1089: rotate-external-id endpoint は廃止。 ExternalId 更新は delete →
// create の 2 step に統一済 (= 仕様簡素化)。 旧テスト群は撤去。

describe("POST /admin/competitor-accounts/:awsAccountId/rotate-external-id (廃止)", () => {
  it("#1089: should return 404 from the rotate endpoint (= removed)", async () => {
    const res = await app.request("/admin/competitor-accounts/222222222222/rotate-external-id", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });
});

describe("DELETE /admin/competitor-accounts/:awsAccountId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 200 + deleted=true", async () => {
    mocks.deleteCompetitorAccount.mockResolvedValueOnce(undefined);
    const res = await app.request("/admin/competitor-accounts/222222222222", {
      method: "DELETE",
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deleted).toBe(true);
  });

  it("not found は 404", async () => {
    mocks.deleteCompetitorAccount.mockRejectedValueOnce(
      new mocks.CompetitorAccountNotFoundError("999999999999"),
    );
    const res = await app.request("/admin/competitor-accounts/999999999999", {
      method: "DELETE",
    });
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });
});

/* ---- Issue #854: /admin/* middleware enforces TenantAdmin role ---- */

describe("/admin/* middleware (Issue #854)", () => {
  const originalRole = process.env.DEFAULT_USER_ROLE;
  afterEach(() => {
    if (originalRole === undefined) delete process.env.DEFAULT_USER_ROLE;
    else process.env.DEFAULT_USER_ROLE = originalRole;
  });

  it("should return 403 forbidden_role on role mismatch (TenantUser)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser";
    const res = await app.request("/admin/competitor-accounts", { method: "GET" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden_role");
  });

  it("role claim 不在 (= JWT 経由なし) なら 403", async () => {
    delete process.env.DEFAULT_USER_ROLE;
    const res = await app.request("/admin/competitor-accounts", { method: "GET" });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
  });

  it("healthz should skip the role check and return 200", async () => {
    delete process.env.DEFAULT_USER_ROLE;
    const res = await app.request("/admin/competitor-accounts/healthz", { method: "GET" });
    expect(res.status).toBe(StatusCodes.OK);
  });
});
