import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  summarizeTenants: vi.fn(),
  listEventsForTenant: vi.fn(),
  getEventDetailForTenant: vi.fn(),
  getDeploymentForTenant: vi.fn(),
  getStackProgressForTenant: vi.fn(),
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/shared", () => ({
  buildSharedResources: () => ({
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send: vi.fn() },
  }),
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/summary", () => ({
  summarizeTenants: mocks.summarizeTenants,
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/events", () => ({
  listEventsForTenant: mocks.listEventsForTenant,
  getEventDetailForTenant: mocks.getEventDetailForTenant,
  // redactTeams は handler 層では未使用だが、import 経路が同 module なので no-op stub。
  redactTeams: (teams: unknown[]) => teams,
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/deployments", () => ({
  getDeploymentForTenant: mocks.getDeploymentForTenant,
  getStackProgressForTenant: mocks.getStackProgressForTenant,
  defaultCfnClient: () => undefined,
}));

const { app } = await import("../../lib/admin-insight/handlers/admin-insight-handler/index");

/**
 * API GW v2 JWT Authorizer 経由で渡される event の最小 shape。
 * `c.env.event.requestContext.authorizer.jwt.claims` に `cognito:groups` / `sub` を入れる
 * (= handler の `isSystemAdmin` / `resolveCognitoSub` がこのパスを読む)。
 */
function withClaims(claims: Record<string, unknown>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims } },
    },
  };
}

const VALID_EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const VALID_JOB_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B3";

describe("GET /admin/insight/tenants/summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin group claim があれば 200 を返すべき", async () => {
    mocks.summarizeTenants.mockResolvedValueOnce({
      items: [{ tenantId: "t-1", activeDeploys: 2, failedDeploys: 0, totalEvents: 3 }],
    });
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "user-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ tenantId: string; activeDeploys: number }>;
    };
    expect(body.items[0].tenantId).toBe("t-1");
  });

  it("SystemAdmin claim 無し (Tenant Admin) は 403 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "cognito:groups": ["TenantAdmin"], sub: "user-1" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("claims が無い (= JWT 経路を通っていない) なら 403 を返すべき", async () => {
    const res = await app.request("/admin/insight/tenants/summary?tenantIds=t-1");
    expect(res.status).toBe(403);
  });

  it("cognito:groups が string で SystemAdmin を含むなら認可するべき", async () => {
    mocks.summarizeTenants.mockResolvedValueOnce({ items: [] });
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "cognito:groups": "[SystemAdmin]", sub: "u" }) },
    );
    expect(res.status).toBe(200);
  });

  it("tenantIds query が空なら 200 + 空 items を返すべき (DDB は叩かない)", async () => {
    const res = await app.request(
      "/admin/insight/tenants/summary",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [] });
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("不正な tenant ID 文字種 (例: `tenant 1` スペース) は 400", async () => {
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=tenant%201",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("tenantIds 100 件超は 400", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `t${i}`).join(",");
    const res = await app.request(
      `/admin/insight/tenants/summary?tenantIds=${many}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("内部 throw は 500 + body { error: 'internal_error' } を返すべき", async () => {
    mocks.summarizeTenants.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    // message が body に漏れていないことも確認 (PR-570 同型の defensive 規約)。
    expect(JSON.stringify(body)).not.toContain("ddb down");
  });

  it("ADR-011 D5 audit log: 各 read で admin.insight.read を console.log するべき", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.summarizeTenants.mockResolvedValueOnce({ items: [] });
    await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "admin-sub-xyz" }) },
    );
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (c as { event?: string }).event === "admin.insight.read" &&
          (c as { admin?: string }).admin === "admin-sub-xyz",
      ),
    ).toBe(true);
    spy.mockRestore();
  });
});

describe("GET /admin/insight/healthz", () => {
  it("認可不要で 200 を返すべき (= API GW で除外する余地もあるが Lambda 側も対応)", async () => {
    const res = await app.request("/admin/insight/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

// ============ Phase 1.B drill-down routes (#598) ============

describe("GET /admin/insight/tenants/:tenantId/events (Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin claim 無しは 403 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/tenants/t1/events",
      {},
      { event: withClaims({ "cognito:groups": ["TenantAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.listEventsForTenant).not.toHaveBeenCalled();
  });

  it("正常系: listEventsForTenant を tenantId 指定で呼ぶべき", async () => {
    mocks.listEventsForTenant.mockResolvedValueOnce({
      items: [
        {
          eventId: VALID_EVENT_ID,
          name: "Event A",
          status: "READY",
          teamCount: 2,
          problemCount: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          updatedAt: "2026-05-11T00:00:00.000Z",
          expiresAt: 0,
        },
      ],
    });
    const res = await app.request(
      "/admin/insight/tenants/t-acme/events?limit=10",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.listEventsForTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: "t-acme", limit: 10 }),
    );
  });

  it("不正な tenantId は 400", async () => {
    const res = await app.request(
      "/admin/insight/tenants/has%20space/events",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.listEventsForTenant).not.toHaveBeenCalled();
  });

  it("limit=9999 のような範囲外は 400", async () => {
    const res = await app.request(
      "/admin/insight/tenants/t1/events?limit=9999",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
  });

  it("内部 throw は 500", async () => {
    mocks.listEventsForTenant.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request(
      "/admin/insight/tenants/t1/events",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("ddb down");
  });
});

describe("GET /admin/insight/tenants/:tenantId/events/:eventId (Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin claim 無しは 403 を返すべき", async () => {
    const res = await app.request(
      `/admin/insight/tenants/t1/events/${VALID_EVENT_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["TenantAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.getEventDetailForTenant).not.toHaveBeenCalled();
  });

  it("正常系: getEventDetailForTenant を呼んで 200", async () => {
    mocks.getEventDetailForTenant.mockResolvedValueOnce({
      eventId: VALID_EVENT_ID,
      name: "E",
      status: "READY",
      teamCount: 1,
      problemCount: 1,
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
      problems: [],
      teams: [],
      deploymentsByProblem: {},
    });
    const res = await app.request(
      `/admin/insight/tenants/t1/events/${VALID_EVENT_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.getEventDetailForTenant).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      VALID_EVENT_ID,
    );
  });

  it("不正な eventId は 400", async () => {
    const res = await app.request(
      "/admin/insight/tenants/t1/events/bad-event",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
  });

  it("Event 不在は 404", async () => {
    mocks.getEventDetailForTenant.mockResolvedValueOnce(undefined);
    const res = await app.request(
      `/admin/insight/tenants/t1/events/${VALID_EVENT_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(404);
  });

  it("teamLoginKey は response に含まれない (security regression pin)", async () => {
    // mock 関数自体は redactTeams を経た shape を返す前提だが、handler 層は受け取った値を
    // そのまま return する。ここでは「もし mock が誤って leak しても body に出ない」 ことを
    // assert する代わりに、shape が teamLoginKey undefined のときに passthrough されることを
    // 確認する。
    mocks.getEventDetailForTenant.mockResolvedValueOnce({
      eventId: VALID_EVENT_ID,
      name: "E",
      status: "READY",
      teamCount: 1,
      problemCount: 1,
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
      problems: [],
      teams: [{ teamId: "t1", internalSlug: "a", teamLoginKey: undefined }],
      deploymentsByProblem: {},
    });
    const res = await app.request(
      `/admin/insight/tenants/t1/events/${VALID_EVENT_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    const body = (await res.json()) as {
      teams: Array<{ teamLoginKey?: string }>;
    };
    expect(body.teams[0].teamLoginKey).toBeUndefined();
  });
});

describe("GET /admin/insight/tenants/:tenantId/deployments/:jobId (Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin claim 無しは 403", async () => {
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["TenantAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.getDeploymentForTenant).not.toHaveBeenCalled();
  });

  it("正常系: getDeploymentForTenant 経由で 200", async () => {
    mocks.getDeploymentForTenant.mockResolvedValueOnce({
      jobId: VALID_JOB_ID,
      problemId: "p1",
      tenantId: "t1",
      awsAccountId: "123",
      region: "ap-northeast-1",
      teamName: "team-a",
      namePrefix: "team-a-p1",
      status: "COMPLETE",
      createdAt: "x",
      updatedAt: "x",
      expiresAt: 0,
    });
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.getDeploymentForTenant).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      VALID_JOB_ID,
    );
  });

  it("不正な jobId は 400", async () => {
    const res = await app.request(
      "/admin/insight/tenants/t1/deployments/not-a-ulid",
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(400);
  });

  it("Deployment 不在は 404", async () => {
    mocks.getDeploymentForTenant.mockResolvedValueOnce(undefined);
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/insight/tenants/:tenantId/deployments/:jobId/stack-progress (Phase 1.B)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin claim 無しは 403", async () => {
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["TenantAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.getStackProgressForTenant).not.toHaveBeenCalled();
  });

  it("kind=ok のとき progress 本体を返すべき", async () => {
    mocks.getStackProgressForTenant.mockResolvedValueOnce({
      kind: "ok",
      progress: {
        jobId: VALID_JOB_ID,
        stackName: "team-a-p1",
        region: "ap-northeast-1",
        consoleUrl: "https://console.aws.amazon.com/...",
        events: [],
        resources: [],
      },
    });
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; consoleUrl: string };
    expect(body.jobId).toBe(VALID_JOB_ID);
  });

  it("kind=not_found は 404", async () => {
    mocks.getStackProgressForTenant.mockResolvedValueOnce({ kind: "not_found" });
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(404);
  });

  it("kind=stack_not_yet_created は 409", async () => {
    mocks.getStackProgressForTenant.mockResolvedValueOnce({ kind: "stack_not_yet_created" });
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(409);
  });

  it("kind=stack_not_found_in_cfn は 200 + 空 events + consoleUrl", async () => {
    mocks.getStackProgressForTenant.mockResolvedValueOnce({
      kind: "stack_not_found_in_cfn",
      consoleUrl: "https://console.aws.amazon.com/cfn",
    });
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      resources: unknown[];
      consoleUrl: string;
    };
    expect(body.events).toEqual([]);
    expect(body.resources).toEqual([]);
    expect(body.consoleUrl).toBe("https://console.aws.amazon.com/cfn");
  });

  it("内部 throw は 500", async () => {
    mocks.getStackProgressForTenant.mockRejectedValueOnce(new Error("cfn down"));
    const res = await app.request(
      `/admin/insight/tenants/t1/deployments/${VALID_JOB_ID}/stack-progress`,
      {},
      { event: withClaims({ "cognito:groups": ["SystemAdmin"], sub: "u" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("cfn down");
  });
});
