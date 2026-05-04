import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", () => ({
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

const { app } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");

const ULID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";

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
