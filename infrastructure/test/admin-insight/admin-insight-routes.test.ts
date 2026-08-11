import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  summarizeTenants: vi.fn(),
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

const { app } = await import("../../lib/admin-insight/handlers/admin-insight-handler/index");

/**
 * API GW v2 JWT Authorizer 経由で渡される event の最小 shape。
 * `c.env.event.requestContext.authorizer.jwt.claims` に `custom:userRole` / `sub` を入れる
 * (= handler の `isSystemAdmin` / `resolveCognitoSub` がこのパスを読む)。SBT 0.3.9 の
 * `auth-custom-resource` が admin user に埋める `custom:userRole = "SystemAdmin"` を再現する。
 */
function withClaims(claims: Record<string, unknown>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims } },
    },
  };
}

describe("#1392: CORS is owned by API Gateway, not the Hono app", () => {
  it("should NOT emit a wildcard Access-Control-Allow-Origin header from the Lambda", async () => {
    const res = await app.request("/admin/insight/healthz");
    expect(res.status).toBe(200);
    // API Gateway HTTP API の corsPreflight allowlist が CORS を一元管理する。 handler 側で
    // `cors({ origin: "*" })` を重ねていた wildcard を撤去したことを pin する。
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /admin/insight/tenants/summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 200 when the SystemAdmin role claim is present", async () => {
    mocks.summarizeTenants.mockResolvedValueOnce({
      items: [{ tenantId: "t-1", activeDeploys: 2, failedDeploys: 0, totalEvents: 3 }],
    });
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "user-1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ tenantId: string; activeDeploys: number }>;
    };
    expect(body.items[0].tenantId).toBe("t-1");
  });

  it("should return 403 when SystemAdmin claim is missing (Tenant Admin)", async () => {
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "custom:userRole": "TenantAdmin", sub: "user-1" }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("should return 403 when claims are missing (= JWT path was not taken)", async () => {
    const res = await app.request("/admin/insight/tenants/summary?tenantIds=t-1");
    expect(res.status).toBe(403);
  });

  it("should trim leading/trailing whitespace on custom:userRole before authorizing", async () => {
    mocks.summarizeTenants.mockResolvedValueOnce({ items: [] });
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "custom:userRole": "  SystemAdmin  ", sub: "u" }) },
    );
    expect(res.status).toBe(200);
  });

  it("should return 200 + empty items when tenantIds query is empty (no DDB call)", async () => {
    const res = await app.request(
      "/admin/insight/tenants/summary",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "u" }) },
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
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "u" }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("tenantIds 100 件超は 400", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `t${i}`).join(",");
    const res = await app.request(
      `/admin/insight/tenants/summary?tenantIds=${many}`,
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "u" }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.summarizeTenants).not.toHaveBeenCalled();
  });

  it("should return 500 + body { error: 'internal_error' } on internal throw", async () => {
    mocks.summarizeTenants.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "u" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    // message が body に漏れていないことも確認 (PR-570 同型の defensive 規約)。
    expect(JSON.stringify(body)).not.toContain("ddb down");
  });

  it("should console.log admin.insight.read on each read", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.summarizeTenants.mockResolvedValueOnce({ items: [] });
    await app.request(
      "/admin/insight/tenants/summary?tenantIds=t-1",
      {},
      { event: withClaims({ "custom:userRole": "SystemAdmin", sub: "admin-sub-xyz" }) },
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
  it("should return 200 without authorization (API GW may exclude it, but Lambda handles it too)", async () => {
    const res = await app.request("/admin/insight/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
