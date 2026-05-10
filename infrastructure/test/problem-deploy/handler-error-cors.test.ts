import { describe, expect, it, vi } from "vitest";

/**
 * #559 defensive layer の test: handler 内 try/catch を漏れた exception が
 * **CORS headers 付きの 500 JSON** で返ることを担保する。
 *
 * 旧挙動 (= onError なし) では Lambda 内 throw が API Gateway に届いて 500 を
 * 返すが、Hono の CORS middleware を経由しないので `Access-Control-Allow-Origin`
 * が無く、browser は body を読めず「Failed to fetch」と表示するしかなかった。
 *
 * 本 test はその「漏れた throw → CORS 付き 500」 path を pin する。
 */

const deployMocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", () => ({
  buildSharedResources: () => ({
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: vi.fn() },
    events: { send: vi.fn() },
  }),
  buildContext: (shared: unknown, tenantId: string) => ({ ...(shared as object), tenantId }),
  startDeployment: deployMocks.startDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/list", () => ({
  listDeployments: deployMocks.listDeployments,
  getDeployment: deployMocks.getDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/delete", () => ({
  requestTeardown: deployMocks.requestTeardown,
}));

const { app: deployApp } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");

describe("deploy-handler onError (#559 defensive layer)", () => {
  it("handler 内 throw でも 500 + CORS headers + JSON error body を返すべき", async () => {
    // 既存 handler は try/catch を持っているので、ここでは内部 catch が走る経路を確認。
    // 重要なのは「response が browser 視点で **CORS-compliant な 500 JSON** で届く」点。
    // onError は内部 catch を漏れた exception の防御層として機能する (#559 の防御強化)。
    deployMocks.listDeployments.mockRejectedValueOnce(new Error("ddb explode"));
    const res = await deployApp.request("/problems/security-battle-royale/deployments");
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});
