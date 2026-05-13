import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// #686: route tests は `app.request()` で JWT を bypass するため DEFAULT_TENANT_ID env で
// tenantId を inject する。 prod では Cognito JWT が必ず claim を載せる前提。
beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
});

const mocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  getStackProgress: vi.fn(),
}));

// `UnknownProblemError` / `UnverifiedCompetitorAccountError` は handler の instanceof 判定
// で使われるため、本物の class 実装を mock の factory 内で `importActual` して露出する (=
// class identity が production と一致する)。`vi.mock` は hoisted されるので body 内で
// `importActual` を呼ぶ async factory にする。
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/deploy-handler/deploy")
  >("../../lib/problem-deploy/handlers/deploy-handler/deploy");
  return {
    buildSharedResources: () => ({
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: vi.fn() },
      events: { send: vi.fn() },
    }),
    buildContext: (shared: unknown, tenantId: string) => ({ ...(shared as object), tenantId }),
    startDeployment: mocks.startDeployment,
    UnknownProblemError: actual.UnknownProblemError,
    UnverifiedCompetitorAccountError: actual.UnverifiedCompetitorAccountError,
  };
});

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/list", () => ({
  listDeployments: mocks.listDeployments,
  getDeployment: mocks.getDeployment,
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/delete", () => ({
  requestTeardown: mocks.requestTeardown,
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/stack-progress", () => ({
  getStackProgress: mocks.getStackProgress,
  defaultCfnClient: vi.fn(),
  // Phase 2.2 (Issue #459): index.ts が `defaultCfnClientForCompetitor` も import するため、
  // mock 経由でも露出する。test では実 STS / SSM を呼ばないよう dummy で返す。
  defaultCfnClientForCompetitor: vi.fn(),
}));

// `app` import を mock 設定後に行う必要がある (= hoisted vi.mock の後)。
const { app } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
// real deploy module を test 側からも touch して error class を共有する。
const { UnverifiedCompetitorAccountError } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/deploy"
);

const ULID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";

const VALID_DEPLOY_BODY = {
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  teamName: "Alpha Team",
};

describe("POST /problems/:problemId/deploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Phase 2.2: UnverifiedCompetitorAccountError は 422 + awsAccountId を返すべき", async () => {
    mocks.startDeployment.mockRejectedValueOnce(
      new UnverifiedCompetitorAccountError("123456789012"),
    );
    const res = await app.request("/problems/security-battle-royale/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_DEPLOY_BODY),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("unverified_competitor_account");
    expect(body.awsAccountId).toBe("123456789012");
  });
});

describe("GET /problems/:problemId/deployments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: 200 と items を返すべき", async () => {
    mocks.listDeployments.mockResolvedValueOnce({
      items: [{ jobId: "JOB1", status: "IN_PROGRESS" }],
      nextCursor: "abc",
    });
    const res = await app.request("/problems/security-battle-royale/deployments");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].jobId).toBe("JOB1");
    expect(body.nextCursor).toBe("abc");
  });

  it("不正な problemId は 400", async () => {
    const res = await app.request("/problems/Invalid_ID!/deployments");
    expect(res.status).toBe(400);
    expect(mocks.listDeployments).not.toHaveBeenCalled();
  });

  it("limit が範囲外なら 400", async () => {
    const res = await app.request("/problems/security-battle-royale/deployments?limit=500");
    expect(res.status).toBe(400);
  });

  it("limit / cursor を listDeployments に渡すべき", async () => {
    mocks.listDeployments.mockResolvedValueOnce({ items: [], nextCursor: undefined });
    await app.request("/problems/security-battle-royale/deployments?limit=10&cursor=xyz");
    expect(mocks.listDeployments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10, cursor: "xyz", problemId: "security-battle-royale" }),
    );
  });

  it("内部エラーは 500", async () => {
    mocks.listDeployments.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request("/problems/security-battle-royale/deployments");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
  });
});

describe("GET /deployments/:jobId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: 200 と item を返すべき", async () => {
    mocks.getDeployment.mockResolvedValueOnce({ jobId: ULID, status: "COMPLETE" });
    const res = await app.request(`/deployments/${ULID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBe(ULID);
  });

  it("不正な jobId (ULID 形式でない) は 400", async () => {
    const res = await app.request("/deployments/not-a-ulid");
    expect(res.status).toBe(400);
    expect(mocks.getDeployment).not.toHaveBeenCalled();
  });

  it("見つからなければ 404", async () => {
    mocks.getDeployment.mockResolvedValueOnce(undefined);
    const res = await app.request(`/deployments/${ULID}`);
    expect(res.status).toBe(404);
  });

  it("内部エラーは 500", async () => {
    mocks.getDeployment.mockRejectedValueOnce(new Error("boom"));
    const res = await app.request(`/deployments/${ULID}`);
    expect(res.status).toBe(500);
  });
});

describe("DELETE /deployments/:jobId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: 202 と previousStatus を返すべき", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({
      kind: "accepted",
      previousStatus: "IN_PROGRESS",
    });
    const res = await app.request(`/deployments/${ULID}`, { method: "DELETE" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.previousStatus).toBe("IN_PROGRESS");
  });

  it("既に DELETING/DELETED なら 200 with already_deleted", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "already_deleted" });
    const res = await app.request(`/deployments/${ULID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("already_deleted");
  });

  it("not_found は 404", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({ kind: "not_found" });
    const res = await app.request(`/deployments/${ULID}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("race は 409", async () => {
    mocks.requestTeardown.mockResolvedValueOnce({
      kind: "race",
      reason: "tenant_or_status_mismatch",
    });
    const res = await app.request(`/deployments/${ULID}`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("不正な jobId は 400 (requestTeardown を呼ばない)", async () => {
    const res = await app.request("/deployments/not-a-ulid", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(mocks.requestTeardown).not.toHaveBeenCalled();
  });

  it("内部エラーは 500", async () => {
    mocks.requestTeardown.mockRejectedValueOnce(new Error("boom"));
    const res = await app.request(`/deployments/${ULID}`, { method: "DELETE" });
    expect(res.status).toBe(500);
  });
});

describe("GET /deployments/:jobId/stack-progress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: 200 と progress を返すべき", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({
      kind: "ok",
      progress: {
        jobId: ULID,
        stackName: "tc-x-y",
        region: "ap-northeast-1",
        consoleUrl: "https://example.com/cfn",
        events: [],
        resources: [],
        stackStatus: "CREATE_IN_PROGRESS",
      },
    });
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBe(ULID);
    expect(body.stackStatus).toBe("CREATE_IN_PROGRESS");
  });

  it("不正な jobId (ULID 形式でない) は 400", async () => {
    const res = await app.request("/deployments/not-a-ulid/stack-progress");
    expect(res.status).toBe(400);
    expect(mocks.getStackProgress).not.toHaveBeenCalled();
  });

  it("DDB 行不在は 404", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "not_found" });
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(404);
  });

  it("stack 未割当 (deploy 極初期) は 409 を返すべき", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "stack_not_yet_created" });
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("stack_not_yet_created");
  });

  it("CFn 上で stack 未在は 200 + consoleUrl のみ返すべき", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({
      kind: "stack_not_found_in_cfn",
      consoleUrl: "https://example.com/cfn",
    });
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.consoleUrl).toBe("https://example.com/cfn");
    expect(body.events).toEqual([]);
    expect(body.resources).toEqual([]);
  });

  it("内部エラーは 500", async () => {
    mocks.getStackProgress.mockRejectedValueOnce(new Error("CFn throttling"));
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
  });
});
