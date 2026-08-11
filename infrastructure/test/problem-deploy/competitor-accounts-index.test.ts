import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: competitor-accounts-handler の Hono app (index.ts) を
 * route-wiring 層として pin する。 既存の competitor-accounts-routes.test.ts は CRUD happy +
 * 一部 error を見ているが、 SAML config 4 route / onError (MissingTenantClaim / Forbidden+audit /
 * generic) / 各 internal_error 枝 / ExternalIdMissing が未カバーで 55% branch だった。
 *
 * store / verify は importOriginal で実 error class を残しつつ関数だけ mock。 saml-routes /
 * audit-log は mock。 auth は実物 (env-driven: DEFAULT_TENANT_ID / DEFAULT_USER_ROLE)。
 */
const mocks = vi.hoisted(() => ({
  createCompetitorAccount: vi.fn(),
  listCompetitorAccounts: vi.fn(),
  deleteCompetitorAccount: vi.fn(),
  verifyCompetitorAccount: vi.fn(),
  routeGet: vi.fn(),
  routePut: vi.fn(),
  routeDelete: vi.fn(),
  writeAuditEvent: vi.fn(),
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
vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createCompetitorAccount: mocks.createCompetitorAccount,
  listCompetitorAccounts: mocks.listCompetitorAccounts,
  deleteCompetitorAccount: mocks.deleteCompetitorAccount,
}));
vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/verify", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyCompetitorAccount: mocks.verifyCompetitorAccount,
}));
vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-routes", () => ({
  routeGet: mocks.routeGet,
  routePut: mocks.routePut,
  routeDelete: mocks.routeDelete,
}));
vi.mock("../../lib/problem-deploy/handlers/shared/audit-log", () => ({
  extractAuditContext: () => ({
    actor: "sub-1",
    actorUsername: "admin@example.com",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
  writeAuditEvent: mocks.writeAuditEvent,
}));

const { app } = await import("../../lib/problem-deploy/handlers/competitor-accounts-handler/index");
const { DuplicateCompetitorAccountError, CompetitorAccountNotFoundError } = await import(
  "../../lib/problem-deploy/handlers/competitor-accounts-handler/store"
);
const { ExternalIdMissingError, AssumeRoleSanityCheckFailedError } = await import(
  "../../lib/problem-deploy/handlers/competitor-accounts-handler/verify"
);

const { bindScope, capabilityScope, MACHINE_CAPABILITIES } = await import(
  "../../lib/problem-deploy/handlers/shared/machine-scopes"
);

const ACCT = "123456789012";
const validCreate = { awsAccountId: ACCT, competitorRoleName: "TenkaCloud-deploy-Role" };

/** Cognito authorizer が machine token に付ける claims。 */
function machineEnv() {
  return {
    event: {
      requestContext: {
        authorizer: {
          claims: {
            token_use: "access",
            client_id: "machine-client-1",
            scope: `${MACHINE_CAPABILITIES.map(capabilityScope).join(" ")} ${bindScope("01JABCDEF0123456789ABCDEF")}`,
          },
        },
      },
    },
  };
}
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  mocks.writeAuditEvent.mockResolvedValue(undefined);
  mocks.routeGet.mockResolvedValue({ status: 200, body: { enabled: false } });
  mocks.routePut.mockResolvedValue({ status: 200, body: { enabled: true } });
  mocks.routeDelete.mockResolvedValue({ status: 200, body: { deleted: true } });
});
afterEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  vi.clearAllMocks();
});

describe("healthz + /admin/* role middleware", () => {
  it("should serve healthz without a role check", async () => {
    const res = await app.request("/admin/competitor-accounts/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("should 403 + audit a known-role mismatch (resolveTenantId succeeds)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser"; // not in TENANT_ROLES
    const res = await json("POST", "/admin/competitor-accounts", validCreate);
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_role");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "forbidden", tenantId: "tenant-test" }),
    );
  });

  it("should still audit as 'unknown' tenant when the claim is also missing", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser";
    delete process.env.DEFAULT_TENANT_ID;
    const res = await app.request("/admin/competitor-accounts");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "forbidden", tenantId: "unknown" }),
    );
  });

  it("should 403 with actualRole '(none)' when no role claim is present", async () => {
    delete process.env.DEFAULT_USER_ROLE;
    const res = await app.request("/admin/competitor-accounts");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ actualRole: "(none)" }) }),
    );
  });

  it("should 401 missing_tenant_claim when resolveTenantId throws outside a try (POST create)", async () => {
    // POST create resolves tenantId at the top level (outside the try), so a missing claim
    // propagates to app.onError rather than the route's local 500 catch.
    delete process.env.DEFAULT_TENANT_ID; // role ok, tenant claim absent
    const res = await json("POST", "/admin/competitor-accounts", validCreate);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect((await res.json()).error).toBe("missing_tenant_claim");
    expect(mocks.createCompetitorAccount).not.toHaveBeenCalled();
  });

  it("should 500 internal_error on an uncaught handler throw (SAML route)", async () => {
    mocks.routeGet.mockRejectedValueOnce(new Error("boom"));
    const res = await app.request("/admin/tenant-saml-config");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("internal_error");
  });

  // #2948: この Lambda は competitor AWS account の登録と削除だけを持つ。machine allowlist
  // (`MACHINE_ROUTE_SCOPES`) に 1 route も載せていないので、どんな capability を持つ machine
  // token でも全 route が届かない。env fallback (`DEFAULT_USER_ROLE=TenantAdmin`) が効いている
  // 状態で試すのが要点で、「fallback が machine token を human へ昇格させない」ことを見ている。
  it.each([
    ["POST", "/admin/competitor-accounts"],
    ["GET", "/admin/competitor-accounts"],
    ["DELETE", `/admin/competitor-accounts/${ACCT}`],
  ])("should deny a machine token on %s %s", async (method, path) => {
    const res = await app.request(
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(validCreate),
      },
      machineEnv(),
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_machine_route");
    expect(mocks.createCompetitorAccount).not.toHaveBeenCalled();
    expect(mocks.deleteCompetitorAccount).not.toHaveBeenCalled();
  });

  it("should not invent a tenant audit row for a machine denial it cannot attribute", async () => {
    // bind scope が無い token は tenant を特定できない。403 は返すが audit 行は書かない。
    const res = await app.request(
      "/admin/competitor-accounts",
      {},
      { event: { requestContext: { authorizer: { claims: { token_use: "access" } } } } },
    );
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_machine_route");
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe("SAML config routes", () => {
  it("should GET the SAML config", async () => {
    const res = await app.request("/admin/tenant-saml-config");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.routeGet).toHaveBeenCalledTimes(1);
  });
  it("should PATCH the SAML config", async () => {
    const res = await json("PATCH", "/admin/tenant-saml-config", { metadataUrl: "https://x" });
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.routePut).toHaveBeenCalledTimes(1);
  });
  it("should PUT the SAML config", async () => {
    const res = await json("PUT", "/admin/tenant-saml-config", { metadataUrl: "https://x" });
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.routePut).toHaveBeenCalledTimes(1);
  });
  it("should DELETE the SAML config", async () => {
    const res = await json("DELETE", "/admin/tenant-saml-config");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.routeDelete).toHaveBeenCalledTimes(1);
  });
});

describe("POST /admin/competitor-accounts", () => {
  it("should 400 invalid_body on malformed JSON", async () => {
    const res = await app.request("/admin/competitor-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("should 400 validation_failed on a bad account id", async () => {
    const res = await json("POST", "/admin/competitor-accounts", {
      awsAccountId: "abc",
      competitorRoleName: "R",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("validation_failed");
  });

  it("should 201 + write a success audit on create", async () => {
    mocks.createCompetitorAccount.mockResolvedValueOnce({ awsAccountId: ACCT, externalId: "ext" });
    const res = await json("POST", "/admin/competitor-accounts", validCreate);
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_competitor_account", outcome: "success" }),
    );
  });

  it("should 409 + conflict audit on a duplicate", async () => {
    mocks.createCompetitorAccount.mockRejectedValueOnce(new DuplicateCompetitorAccountError(ACCT));
    const res = await json("POST", "/admin/competitor-accounts", validCreate);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect((await res.json()).error).toBe("duplicate_account");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "conflict" }),
    );
  });

  it("should 500 on an unexpected create error", async () => {
    mocks.createCompetitorAccount.mockRejectedValueOnce(new Error("ssm down"));
    const res = await json("POST", "/admin/competitor-accounts", validCreate);
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });

  it("should 500 on a non-Error create rejection ('unknown error' branch)", async () => {
    mocks.createCompetitorAccount.mockRejectedValueOnce("plain create fail");
    expect((await json("POST", "/admin/competitor-accounts", validCreate)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /admin/competitor-accounts", () => {
  it("should 200 with the listing", async () => {
    mocks.listCompetitorAccounts.mockResolvedValueOnce([{ awsAccountId: ACCT }]);
    const res = await app.request("/admin/competitor-accounts");
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).items).toHaveLength(1);
  });

  it("should 500 on a list error", async () => {
    mocks.listCompetitorAccounts.mockRejectedValueOnce(new Error("ddb down"));
    expect((await app.request("/admin/competitor-accounts")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });

  it("should 500 on a non-Error list rejection ('unknown error' branch)", async () => {
    mocks.listCompetitorAccounts.mockRejectedValueOnce("plain list fail");
    expect((await app.request("/admin/competitor-accounts")).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("POST /admin/competitor-accounts/:awsAccountId/verify", () => {
  it("should 400 on an invalid account id", async () => {
    expect((await json("POST", "/admin/competitor-accounts/abc/verify")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 on a successful verify", async () => {
    mocks.verifyCompetitorAccount.mockResolvedValueOnce({ awsAccountId: ACCT, verified: true });
    const res = await json("POST", `/admin/competitor-accounts/${ACCT}/verify`);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).verified).toBe(true);
  });
  it("should 404 when the account is not found", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(new CompetitorAccountNotFoundError(ACCT));
    expect((await json("POST", `/admin/competitor-accounts/${ACCT}/verify`)).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
  it("should 409 when the ExternalId is missing", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(new ExternalIdMissingError("tenant-test"));
    const res = await json("POST", `/admin/competitor-accounts/${ACCT}/verify`);
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect((await res.json()).error).toBe("external_id_missing");
  });
  it("should 422 + underlyingErrorName when AssumeRole fails", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(
      new AssumeRoleSanityCheckFailedError(ACCT, "AccessDenied", "denied"),
    );
    const res = await json("POST", `/admin/competitor-accounts/${ACCT}/verify`);
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect((await res.json()).underlyingErrorName).toBe("AccessDenied");
  });
  it("should 500 on an unexpected verify error", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce(new Error("sts down"));
    expect((await json("POST", `/admin/competitor-accounts/${ACCT}/verify`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });

  it("should 500 on a non-Error verify rejection ('unknown error' branch)", async () => {
    mocks.verifyCompetitorAccount.mockRejectedValueOnce("plain verify fail");
    expect((await json("POST", `/admin/competitor-accounts/${ACCT}/verify`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("DELETE /admin/competitor-accounts/:awsAccountId", () => {
  it("should 400 on an invalid account id", async () => {
    expect((await json("DELETE", "/admin/competitor-accounts/abc")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 + write a success audit on delete", async () => {
    mocks.deleteCompetitorAccount.mockResolvedValueOnce(undefined);
    const res = await json("DELETE", `/admin/competitor-accounts/${ACCT}`);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete_competitor_account", outcome: "success" }),
    );
  });
  it("should 404 when the account is not found", async () => {
    mocks.deleteCompetitorAccount.mockRejectedValueOnce(new CompetitorAccountNotFoundError(ACCT));
    expect((await json("DELETE", `/admin/competitor-accounts/${ACCT}`)).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
  it("should 500 on an unexpected delete error", async () => {
    mocks.deleteCompetitorAccount.mockRejectedValueOnce(new Error("ddb down"));
    expect((await json("DELETE", `/admin/competitor-accounts/${ACCT}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });

  it("should 500 on a non-Error delete rejection ('unknown error' branch)", async () => {
    mocks.deleteCompetitorAccount.mockRejectedValueOnce("plain delete fail");
    expect((await json("DELETE", `/admin/competitor-accounts/${ACCT}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});
