import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: deploy-handler の Hono app (index.ts) を route-wiring 層として pin する。
 * 既存 deploy-handler-routes / handler-error-cors / role-gates が ~70% branch までしか
 * 通しておらず、 各 route の validation / outcome / error 枝の多くと onError MissingTenantClaim /
 * stack-progress の 4 outcome / retry rethrow / delete の 5 outcome が未カバーだった。
 *
 * deploy / retry / stack-progress は importOriginal で実 error class / client const を残しつつ
 * 関数だけ mock。 list / delete は mock。 runtime は実物 (RuntimeNotSupportedError を throw)。
 * auth は実物 (env-driven)。 onError generic は top-level throwing route で踏む。
 */
const mocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  validateRetryRequest: vi.fn(),
  retryDeployments: vi.fn(),
  getStackProgress: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildSharedResources: () => ({
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: vi.fn() },
    events: { send: vi.fn() },
  }),
  buildContext: (shared: unknown, tenantId: string) => ({ ...(shared as object), tenantId }),
  startDeployment: mocks.startDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/list", () => ({
  listDeployments: mocks.listDeployments,
  getDeployment: mocks.getDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/delete", () => ({
  requestTeardown: mocks.requestTeardown,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/retry", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  validateRetryRequest: mocks.validateRetryRequest,
  retryDeployments: mocks.retryDeployments,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/stack-progress", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStackProgress: mocks.getStackProgress,
}));

const { app } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
const { UnknownProblemError, UnverifiedCompetitorAccountError } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/deploy"
);
const { InvalidRetryRequestError } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/retry"
);
const { RuntimeNotSupportedError } = await import(
  "../../lib/problem-deploy/handlers/shared/runtime/index"
);

const JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const PROBLEM_ID = "p-1";
const validDeploy = { region: "ap-northeast-1", awsAccountId: "123456789012", teamName: "Alpha" };
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// onError generic を try/catch 外で踏む top-level throwing route。
app.get("/__deploy_throw__", () => {
  throw new Error("boom");
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  delete process.env.DEFAULT_TENANT_SUSPENDED;
  mocks.validateRetryRequest.mockReturnValue({ failedJobIds: [JOB_ID] });
});
afterEach(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
  delete process.env.DEFAULT_TENANT_SUSPENDED;
  vi.clearAllMocks();
});

describe("wiring: healthz / middleware / onError", () => {
  it("should serve /healthz without auth", async () => {
    delete process.env.DEFAULT_USER_ROLE; // healthz skips the role check
    const res = await app.request("/healthz");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });
  it("should 403 forbidden_role on a non-tenant role (middleware)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantUser";
    const res = await app.request("/deployments");
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("forbidden_role");
  });
  it("should 401 missing_tenant_claim when resolveTenantId throws outside a try", async () => {
    delete process.env.DEFAULT_TENANT_ID; // role ok, tenant claim absent → POST deploy line 157
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy);
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect((await res.json()).error).toBe("missing_tenant_claim");
  });
  it("should 500 internal_error on an uncaught throw (with CORS)", async () => {
    const res = await app.request("/__deploy_throw__");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("internal_error");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("POST /problems/:problemId/deploy", () => {
  it("should 400 invalid_problem_id", async () => {
    expect((await json("POST", "/problems/Bad_ID/deploy", validDeploy)).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 400 invalid_body on malformed JSON", async () => {
    const res = await app.request(`/problems/${PROBLEM_ID}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_body");
  });
  it("should 400 validation_failed on a bad body", async () => {
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, { region: "bad" });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("validation_failed");
  });
  it("should 202 on a successful deploy", async () => {
    mocks.startDeployment.mockResolvedValueOnce({ jobId: JOB_ID });
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy);
    expect(res.status).toBe(StatusCodes.ACCEPTED);
  });
  it("should 403 tenant_suspended before starting a deploy", async () => {
    process.env.DEFAULT_TENANT_SUSPENDED = "true";
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy);
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("tenant_suspended");
    expect(mocks.startDeployment).not.toHaveBeenCalled();
  });
  it("should 404 on UnknownProblemError", async () => {
    mocks.startDeployment.mockRejectedValueOnce(new UnknownProblemError(PROBLEM_ID));
    expect((await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy)).status).toBe(
      StatusCodes.NOT_FOUND,
    );
  });
  it("should 422 on UnverifiedCompetitorAccountError", async () => {
    mocks.startDeployment.mockRejectedValueOnce(
      new UnverifiedCompetitorAccountError("123456789012"),
    );
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy);
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect((await res.json()).error).toBe("unverified_competitor_account");
  });
  it("should 422 on RuntimeNotSupportedError", async () => {
    mocks.startDeployment.mockRejectedValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: minimal ProblemRuntime for the error.
      new RuntimeNotSupportedError({ provider: "azure", engine: "bicep" } as any),
    );
    const res = await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy);
    expect(res.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
    expect((await res.json()).error).toBe("runtime_not_supported");
  });
  it("should 500 on an unexpected deploy error", async () => {
    mocks.startDeployment.mockRejectedValueOnce(new Error("boom"));
    expect((await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
  it("should 500 on a non-Error deploy rejection ('unknown error' branch)", async () => {
    mocks.startDeployment.mockRejectedValueOnce("plain fail");
    expect((await json("POST", `/problems/${PROBLEM_ID}/deploy`, validDeploy)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /problems/:problemId/deployments", () => {
  it("should 400 invalid_problem_id", async () => {
    expect((await app.request("/problems/Bad_ID/deployments")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 400 invalid_limit", async () => {
    expect((await app.request(`/problems/${PROBLEM_ID}/deployments?limit=0`)).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 200 with the listing", async () => {
    mocks.listDeployments.mockResolvedValueOnce({ items: [] });
    expect((await app.request(`/problems/${PROBLEM_ID}/deployments?limit=5&cursor=c`)).status).toBe(
      StatusCodes.OK,
    );
  });
  it("should 500 on a list error", async () => {
    mocks.listDeployments.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request(`/problems/${PROBLEM_ID}/deployments`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
  it("should 500 on a non-Error list rejection ('unknown error' branch)", async () => {
    mocks.listDeployments.mockRejectedValueOnce("plain fail");
    expect((await app.request(`/problems/${PROBLEM_ID}/deployments`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /deployments (tenant-wide)", () => {
  it("should 400 invalid_limit", async () => {
    expect((await app.request("/deployments?limit=999999")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 200 with the listing", async () => {
    mocks.listDeployments.mockResolvedValueOnce({ items: [] });
    expect((await app.request("/deployments")).status).toBe(StatusCodes.OK);
  });
  it("should 500 on a list error", async () => {
    mocks.listDeployments.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request("/deployments")).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
  it("should 500 on a non-Error list rejection ('unknown error' branch)", async () => {
    mocks.listDeployments.mockRejectedValueOnce("plain fail");
    expect((await app.request("/deployments")).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});

describe("GET /deployments/:jobId", () => {
  it("should 400 invalid_job_id", async () => {
    expect((await app.request("/deployments/not-a-ulid")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 404 when not found", async () => {
    mocks.getDeployment.mockResolvedValueOnce(null);
    expect((await app.request(`/deployments/${JOB_ID}`)).status).toBe(StatusCodes.NOT_FOUND);
  });
  it("should 200 with the item", async () => {
    mocks.getDeployment.mockResolvedValueOnce({ jobId: JOB_ID });
    expect((await app.request(`/deployments/${JOB_ID}`)).status).toBe(StatusCodes.OK);
  });
  it("should 500 on a getDeployment error", async () => {
    mocks.getDeployment.mockRejectedValueOnce(new Error("ddb"));
    expect((await app.request(`/deployments/${JOB_ID}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
  it("should 500 on a non-Error getDeployment rejection ('unknown error' branch)", async () => {
    mocks.getDeployment.mockRejectedValueOnce("plain fail");
    expect((await app.request(`/deployments/${JOB_ID}`)).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("GET /deployments/:jobId/stack-progress", () => {
  const path = `/deployments/${JOB_ID}/stack-progress`;
  it("should 400 invalid_job_id", async () => {
    expect((await app.request("/deployments/bad/stack-progress")).status).toBe(
      StatusCodes.BAD_REQUEST,
    );
  });
  it("should 404 not_found", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "not_found" });
    expect((await app.request(path)).status).toBe(StatusCodes.NOT_FOUND);
  });
  it("should 409 stack_not_yet_created", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "stack_not_yet_created" });
    expect((await app.request(path)).status).toBe(StatusCodes.CONFLICT);
  });
  it("should 200 with an empty body on stack_not_found_in_cfn", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({
      kind: "stack_not_found_in_cfn",
      consoleUrl: "https://console",
    });
    const res = await app.request(path);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).consoleUrl).toBe("https://console");
  });
  it("should 200 with the progress payload", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "ok", progress: { events: [] } });
    const res = await app.request(path);
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ events: [] });
  });
  it("should 500 on a getStackProgress error", async () => {
    mocks.getStackProgress.mockRejectedValueOnce(new Error("cfn"));
    expect((await app.request(path)).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
  it("should 500 on a non-Error getStackProgress rejection ('unknown error' branch)", async () => {
    mocks.getStackProgress.mockRejectedValueOnce("plain fail");
    expect((await app.request(path)).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});

describe("POST /deployments/retry", () => {
  it("should 400 invalid_body on malformed JSON", async () => {
    const res = await app.request("/deployments/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_body");
  });
  it("should 400 invalid_request on InvalidRetryRequestError", async () => {
    mocks.validateRetryRequest.mockImplementationOnce(() => {
      throw new InvalidRetryRequestError("too many");
    });
    const res = await json("POST", "/deployments/retry", { failedJobIds: [] });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_request");
  });
  it("should 500 (rethrow → onError) on a non-InvalidRetry validation error", async () => {
    mocks.validateRetryRequest.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect((await json("POST", "/deployments/retry", { failedJobIds: [JOB_ID] })).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
  it("should 200 on a successful retry", async () => {
    mocks.retryDeployments.mockResolvedValueOnce({ items: [] });
    expect((await json("POST", "/deployments/retry", { failedJobIds: [JOB_ID] })).status).toBe(
      StatusCodes.OK,
    );
  });
  it("should 403 tenant_suspended before retrying deployments", async () => {
    process.env.DEFAULT_TENANT_SUSPENDED = "true";
    const res = await json("POST", "/deployments/retry", { failedJobIds: [JOB_ID] });
    expect(res.status).toBe(StatusCodes.FORBIDDEN);
    expect((await res.json()).error).toBe("tenant_suspended");
    expect(mocks.retryDeployments).not.toHaveBeenCalled();
  });
  it("should 500 on a retryDeployments error", async () => {
    mocks.retryDeployments.mockRejectedValueOnce(new Error("ddb"));
    expect((await json("POST", "/deployments/retry", { failedJobIds: [JOB_ID] })).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
  it("should 500 on a non-Error retry rejection ('unknown error' branch)", async () => {
    mocks.retryDeployments.mockRejectedValueOnce("plain fail");
    expect((await json("POST", "/deployments/retry", { failedJobIds: [JOB_ID] })).status).toBe(
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  });
});

describe("DELETE /deployments/:jobId", () => {
  const path = `/deployments/${JOB_ID}`;
  it("should 400 invalid_job_id", async () => {
    expect((await json("DELETE", "/deployments/bad")).status).toBe(StatusCodes.BAD_REQUEST);
  });
  it("should 404 not_found", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "not_found" });
    expect((await json("DELETE", path)).status).toBe(StatusCodes.NOT_FOUND);
  });
  it("should 200 already_deleted", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "already_deleted" });
    const res = await json("DELETE", path);
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).status).toBe("already_deleted");
  });
  it("should 409 on a race", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "race" });
    expect((await json("DELETE", path)).status).toBe(StatusCodes.CONFLICT);
  });
  it("should 500 missing_required_fields", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "missing_required_fields", fields: ["x"] });
    const res = await json("DELETE", path);
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect((await res.json()).error).toBe("missing_required_fields");
  });
  it("should 202 accepted with previousStatus", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "accepted", previousStatus: "COMPLETE" });
    const res = await json("DELETE", path);
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect((await res.json()).previousStatus).toBe("COMPLETE");
  });
  it("should 500 on a requestTeardown error", async () => {
    mocks.requestTeardown.mockRejectedValueOnce(new Error("ddb"));
    expect((await json("DELETE", path)).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
  it("should 500 on a non-Error requestTeardown rejection ('unknown error' branch)", async () => {
    mocks.requestTeardown.mockRejectedValueOnce("plain fail");
    expect((await json("DELETE", path)).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});
