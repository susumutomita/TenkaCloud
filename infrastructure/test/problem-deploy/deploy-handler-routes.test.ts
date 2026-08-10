import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// #686: route tests は `app.request()` で JWT を bypass するため DEFAULT_TENANT_ID env で
// tenantId を inject する。 prod では Cognito JWT が必ず claim を載せる前提。
beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  // Issue #854: handler middleware が TenantAdmin role を要求するので test 環境では env で inject。
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});

const mocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  getStackProgress: vi.fn(),
  resolveIdempotencyRepository: vi.fn(),
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

// [Issue #3002] Idempotency seam。 production の `shared.js` は runtime 経由で backend を
// 選ぶが、 この suite の fake shared には runtime が無い。 seam だけ差し替えて、 route の
// 分岐 (replay / 進行中 / キー再利用 / 記録) を実際に通す。
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/shared", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/deploy-handler/shared")
  >("../../lib/problem-deploy/handlers/deploy-handler/shared");
  return { ...actual, resolveIdempotencyRepository: mocks.resolveIdempotencyRepository };
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

  it("#1766: should return 429 + quota info when startDeployment hits the tier quota", async () => {
    const { DeployQuotaExceededError } = await import(
      "../../lib/problem-deploy/handlers/deploy-handler/deploy-quota"
    );
    mocks.startDeployment.mockRejectedValueOnce(new DeployQuotaExceededError("basic", 2, 2));
    const res = await app.request("/problems/security-battle-royale/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_DEPLOY_BODY),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("deploy_quota_exceeded");
    expect(body).toMatchObject({ tier: "basic", limit: 2, active: 2 });
    // route は JWT claim 由来の quotaTier を invocation に詰めて渡す (enforcement は
    // startDeployment 内、PR-1803 review)。claim 不在の test 環境では basic に倒れる。
    expect(mocks.startDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quotaTier: "basic" }),
    );
  });

  it("Phase 2.2: should return 422 + awsAccountId on UnverifiedCompetitorAccountError", async () => {
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

  it("normal case: should return 200 with items", async () => {
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

  it("should pass limit / cursor through to listDeployments", async () => {
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

  it("normal case: should return 200 with item", async () => {
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

  it("normal case: should return 202 with previousStatus", async () => {
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

  it("normal case: should return 200 with progress", async () => {
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

  it("should return 409 when no stack is assigned yet (very early deploy)", async () => {
    mocks.getStackProgress.mockResolvedValueOnce({ kind: "stack_not_yet_created" });
    const res = await app.request(`/deployments/${ULID}/stack-progress`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("stack_not_yet_created");
  });

  it("should return only 200 + consoleUrl when the stack is missing on CFn", async () => {
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

/**
 * [Issue #3002] `Idempotency-Key` を付けたときの route の挙動。
 *
 * storage の parity と判断ロジックは専用 suite が見ている。 ここが見るのは **route が
 * 実際に startDeployment を呼ばないこと**で、 これが崩れると再送のたびに deploy が走り、
 * 競技アカウントに CloudFormation stack が増える。
 */
describe("POST /problems/:problemId/deploy with Idempotency-Key (Issue 3002)", () => {
  const KEY = "11111111-2222-4333-8444-555555555555";

  /** 実際の SQLite を使う (fake を書くと排他の検証にならない)。 */
  async function inMemoryIdempotency() {
    const { DatabaseSync } = await import("node:sqlite");
    const { IDEMPOTENCY_TABLE_SQL, SqlIdempotencyRepository } = await import(
      "../../lib/problem-deploy/control-data/idempotency-repository"
    );
    const db = new DatabaseSync(":memory:");
    db.exec(IDEMPOTENCY_TABLE_SQL);
    const executor = {
      run: (sql: string, params: readonly unknown[] = []) => ({
        changes: db.prepare(sql).run(...(params as never[])).changes,
      }),
      get: (sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).get(...(params as never[])),
      all: (sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).all(...(params as never[])),
      batch: () => [],
    };
    // biome-ignore lint/suspicious/noExplicitAny: test executor は必要な 3 メソッドだけ持つ
    return new SqlIdempotencyRepository(executor as any);
  }

  function deployRequest(key?: string) {
    return new Request("http://local/problems/p1/deploy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(VALID_DEPLOY_BODY),
    });
  }

  beforeEach(async () => {
    mocks.resolveIdempotencyRepository.mockResolvedValue(await inMemoryIdempotency());
  });

  it("は 1 回目を通し、成功を記録する", async () => {
    mocks.startDeployment.mockResolvedValue({ jobId: ULID });
    const res = await app.request(deployRequest(KEY));
    expect(res.status).toBe(202);
    expect(mocks.startDeployment).toHaveBeenCalledTimes(1);
  });

  it("は再送で startDeployment を呼ばず、1 回目の結果を返す", async () => {
    // この suite の存在理由。 呼ばれてしまうと stack が 2 つできる。
    mocks.startDeployment.mockResolvedValue({ jobId: ULID });
    const repository = await inMemoryIdempotency();
    mocks.resolveIdempotencyRepository.mockResolvedValue(repository);

    const first = await app.request(deployRequest(KEY));
    expect(first.status).toBe(202);
    mocks.startDeployment.mockClear();

    const replay = await app.request(deployRequest(KEY));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ jobId: ULID });
    expect(mocks.startDeployment).not.toHaveBeenCalled();
  });

  it("は失敗した deploy も記録し、再送で再実行しない", async () => {
    mocks.startDeployment.mockRejectedValue(new UnverifiedCompetitorAccountError("123456789012"));
    const repository = await inMemoryIdempotency();
    mocks.resolveIdempotencyRepository.mockResolvedValue(repository);

    const first = await app.request(deployRequest(KEY));
    const firstStatus = first.status;
    mocks.startDeployment.mockClear();

    const replay = await app.request(deployRequest(KEY));
    expect(replay.status).toBe(firstStatus);
    expect(mocks.startDeployment).not.toHaveBeenCalled();
  });

  it("は同じキーに違う本文が来たら 422 で断る", async () => {
    mocks.startDeployment.mockResolvedValue({ jobId: ULID });
    const repository = await inMemoryIdempotency();
    mocks.resolveIdempotencyRepository.mockResolvedValue(repository);
    await app.request(deployRequest(KEY));
    mocks.startDeployment.mockClear();

    const other = await app.request(
      new Request("http://local/problems/p1/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": KEY },
        body: JSON.stringify({ ...VALID_DEPLOY_BODY, awsAccountId: "999988887777" }),
      }),
    );
    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({ error: "idempotency_key_reused" });
    expect(mocks.startDeployment).not.toHaveBeenCalled();
  });

  it("は長すぎるキーを 400 で断る", async () => {
    const res = await app.request(deployRequest("x".repeat(256)));
    expect(res.status).toBe(400);
    expect(mocks.startDeployment).not.toHaveBeenCalled();
  });

  it("はヘッダが無ければ storage を触らない", async () => {
    // 既存クライアントの経路。 resolver すら呼ばれないこと。
    mocks.startDeployment.mockResolvedValue({ jobId: ULID });
    mocks.resolveIdempotencyRepository.mockClear();
    const res = await app.request(deployRequest());
    expect(res.status).toBe(202);
    expect(mocks.resolveIdempotencyRepository).not.toHaveBeenCalled();
  });
});
