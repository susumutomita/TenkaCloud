import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("201 で externalId / tenkaCloudAccountId を含む body を返すべき", async () => {
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

  it("validation 失敗 (= awsAccountId が 12 桁でない) は 400 を返すべき", async () => {
    const res = await app.request("/admin/competitor-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ awsAccountId: "abc" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.createCompetitorAccount).not.toHaveBeenCalled();
  });

  it("Duplicate は 409 を返すべき", async () => {
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

  it("一覧 (verified 混在) を返し externalId は含めないべき", async () => {
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

  it("STS 成功時は 200 + verified=true を返すべき", async () => {
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

  it("STS AssumeRole 失敗時は 422 + underlyingErrorName を返すべき", async () => {
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

  it("row なしは 404 を返すべき", async () => {
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

describe("POST /admin/competitor-accounts/:awsAccountId/rotate-external-id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + 新 externalId + tenkaCloudAccountId を含む Reveal payload を返すべき", async () => {
    mocks.rotateExternalIdForAccount.mockResolvedValueOnce({
      awsAccountId: "222222222222",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      verifiedAt: "2026-05-11T00:00:00.000Z",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z",
      rotatedAt: "2026-05-12T00:00:00.000Z",
      externalId: "new-rotated-id",
      tenkaCloudAccountId: "111111111111",
    });
    const res = await app.request("/admin/competitor-accounts/222222222222/rotate-external-id", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.externalId).toBe("new-rotated-id");
    expect(body.tenkaCloudAccountId).toBe("111111111111");
    expect(body.rotatedAt).toBe("2026-05-12T00:00:00.000Z");
  });

  it("row なしは 404 を返すべき", async () => {
    mocks.rotateExternalIdForAccount.mockRejectedValueOnce(
      new mocks.CompetitorAccountNotFoundError("999999999999"),
    );
    const res = await app.request("/admin/competitor-accounts/999999999999/rotate-external-id", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });

  it("SSM に現 ExternalId が無いと 409 (external_id_missing) を返すべき", async () => {
    mocks.rotateExternalIdForAccount.mockRejectedValueOnce(
      new mocks.ExternalIdMissingForRotationError("tenant-acme"),
    );
    const res = await app.request("/admin/competitor-accounts/222222222222/rotate-external-id", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.CONFLICT);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("external_id_missing");
  });

  it("awsAccountId が 12 桁でないと 400", async () => {
    const res = await app.request("/admin/competitor-accounts/abc/rotate-external-id", {
      method: "POST",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.rotateExternalIdForAccount).not.toHaveBeenCalled();
  });
});

describe("DELETE /admin/competitor-accounts/:awsAccountId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 + deleted=true を返すべき", async () => {
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
