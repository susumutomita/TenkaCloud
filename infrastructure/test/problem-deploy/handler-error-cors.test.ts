import { describe, expect, it, vi } from "vitest";

/**
 * #559 defensive layer の test (PR-570 review 指摘で書き直し)。
 *
 * 旧 test は `listDeployments.mockRejectedValueOnce` で throw させていたが、handler 内の
 * 既存 try/catch が catch して `c.json({ error: "internal_error" }, 500)` を返すため、
 * **`app.onError` は実際には発火していなかった** (= test 名と挙動が乖離)。
 *
 * 本 test は test 専用の throwing route を動的に追加して、try/catch を経由せず Hono の
 * onError に到達する path を実際に exercise する。verify する点:
 *   - status: 500
 *   - `Access-Control-Allow-Origin: *` header が付く (= CORS middleware が onError 経路でも適用)
 *   - body: `{ error: "internal_error" }` (= `message` は漏らさない、security fix)
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

const eventMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  getEventDetail: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/shared", () => ({
  buildEventSharedResources: () => ({
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: vi.fn() },
    events: { send: vi.fn() },
    problemsCatalog: {},
  }),
  queryDeploymentsByEvent: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/list", () => ({
  listEvents: eventMocks.listEvents,
  getEventDetail: eventMocks.getEventDetail,
}));

const { app: deployApp } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
const { app: eventApp } = await import("../../lib/problem-deploy/handlers/event-handler/index");

// onError を実際に exercise する test 専用 throwing route。Hono の app instance は import
// 後でも `app.get(...)` で route 追加可能なので、try/catch を持たない handler を 1 本足す。
// この path にアクセスすると **handler 内 catch を経由せず** middleware → onError に到達する。
const TEST_THROW_PATH = "/__test_throw__";
deployApp.get(TEST_THROW_PATH, () => {
  throw new Error("boom from deploy");
});
eventApp.get(TEST_THROW_PATH, () => {
  throw new Error("boom from events");
});

describe("Hono handler onError (#559 defensive layer)", () => {
  it("deploy-handler: 未捕捉 throw でも 500 + CORS headers + JSON `error` を返すべき", async () => {
    const res = await deployApp.request(TEST_THROW_PATH);
    expect(res.status).toBe(500);
    // CORS middleware が onError 経路でも適用される (#559 防御の本旨)
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("internal_error");
    // PR-570 review: 内部 message を browser に漏らさない (security)
    expect(body.message).toBeUndefined();
  });

  it("event-handler: 未捕捉 throw でも 500 + CORS headers + JSON `error` を返すべき", async () => {
    const res = await eventApp.request(TEST_THROW_PATH);
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBeUndefined();
  });

  it("既存 handler の内部 catch 経路も 500 + CORS で返るべき (= 既存挙動の regression 防止)", async () => {
    // 既存 handler は throw を内部 catch → `c.json({ error: "internal_error" }, 500)` する。
    // onError ではなく通常の return path だが、CORS middleware が等しく適用されることを pin。
    deployMocks.listDeployments.mockRejectedValueOnce(new Error("inner catch path"));
    const res = await deployApp.request("/problems/security-battle-royale/deployments");
    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });
});
