import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #949 (ADR-020 Phase C): admin-insight Lambda の /admin/insight/system-users
 * route 群が SystemAdmin 認可 + CRUD shape を満たすことを pin する。
 *
 * 既存 admin-insight-routes.test.ts と同じ mock 戦略:
 *   - shared 構築 / Cognito wrapper は vi.mock で stub
 *   - JWT claim は `event.requestContext.authorizer.jwt.claims` 経由で inject
 */

const ORIGINAL_USER_POOL = process.env.CONTROL_PLANE_USER_POOL_ID;
beforeEach(() => {
  // 各 test 開始時に env を test-pool に固定 (= 「未設定で 503」 だけ test 内で削除する)
  process.env.CONTROL_PLANE_USER_POOL_ID = "test-pool";
});
afterEach(() => {
  if (ORIGINAL_USER_POOL === undefined) delete process.env.CONTROL_PLANE_USER_POOL_ID;
  else process.env.CONTROL_PLANE_USER_POOL_ID = ORIGINAL_USER_POOL;
});

const mocks = vi.hoisted(() => ({
  listSystemUsers: vi.fn(),
  createSystemUser: vi.fn(),
  deleteSystemUser: vi.fn(),
  updateSystemUserRole: vi.fn(),
  getSystemUser: vi.fn(),
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
  summarizeTenants: vi.fn(),
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/events", () => ({
  listEventsForTenant: vi.fn(),
  getEventDetailForTenant: vi.fn(),
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/deployments", () => ({
  getDeploymentForTenant: vi.fn(),
  getStackProgressForTenant: vi.fn(),
  defaultCfnClient: () => undefined,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/pipeline-executions", () => ({
  listPipelineExecutions: vi.fn(),
  defaultPipelineClient: () => undefined,
}));
vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/state-machine-executions", () => ({
  listStateMachineExecutions: vi.fn(),
  defaultSfnClient: () => undefined,
}));

vi.mock("../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito")
  >("../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito");
  return {
    SYSTEM_ADMIN_GROUP: actual.SYSTEM_ADMIN_GROUP,
    SYSTEM_AUDITOR_GROUP: actual.SYSTEM_AUDITOR_GROUP,
    SYSTEM_GROUPS: actual.SYSTEM_GROUPS,
    DuplicateSystemUserError: actual.DuplicateSystemUserError,
    SystemUserNotFoundError: actual.SystemUserNotFoundError,
    listSystemUsers: mocks.listSystemUsers,
    createSystemUser: mocks.createSystemUser,
    deleteSystemUser: mocks.deleteSystemUser,
    updateSystemUserRole: mocks.updateSystemUserRole,
    getSystemUser: mocks.getSystemUser,
  };
});

const { app } = await import("../../lib/admin-insight/handlers/admin-insight-handler/index");

function withClaims(claims: Record<string, unknown>) {
  return {
    requestContext: {
      authorizer: { jwt: { claims } },
    },
  };
}

const systemAdminClaims = {
  "custom:userRole": "SystemAdmin",
  sub: "admin-sub-1",
  "cognito:username": "admin@example.com",
  email: "admin@example.com",
};
const tenantAdminClaims = {
  "custom:userRole": "TenantAdmin",
  sub: "tenant-1",
};

describe("ADR-020 Phase C / #949: GET /admin/insight/system-users", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SystemAdmin claim があれば 200 + items を返すべき", async () => {
    mocks.listSystemUsers.mockResolvedValueOnce([
      { username: "u1@example.com", email: "u1@example.com", groups: ["SystemAdmin"] },
    ]);
    const res = await app.request(
      "/admin/insight/system-users",
      {},
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(1);
  });

  it("TenantAdmin claim は 403 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/system-users",
      {},
      { event: withClaims(tenantAdminClaims) },
    );
    expect(res.status).toBe(403);
  });

  it("CONTROL_PLANE_USER_POOL_ID 未設定なら 503 を返すべき", async () => {
    delete process.env.CONTROL_PLANE_USER_POOL_ID;
    const res = await app.request(
      "/admin/insight/system-users",
      {},
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("control_plane_user_pool_unconfigured");
  });
});

describe("ADR-020 Phase C / #949: POST /admin/insight/system-users", () => {
  beforeEach(() => vi.clearAllMocks());

  it("有効 body なら 201 を返すべき", async () => {
    mocks.createSystemUser.mockResolvedValueOnce({
      username: "new@example.com",
      email: "new@example.com",
      groups: ["SystemAdmin"],
    });
    const res = await app.request(
      "/admin/insight/system-users",
      {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com", role: "SystemAdmin" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(201);
  });

  it("無効 email は 400 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/system-users",
      {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", role: "SystemAdmin" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(400);
  });

  it("無効 role は 400 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/system-users",
      {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com", role: "Bogus" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(400);
  });

  it("Duplicate email は 409 を返すべき", async () => {
    const { DuplicateSystemUserError } = await import(
      "../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito"
    );
    mocks.createSystemUser.mockRejectedValueOnce(new DuplicateSystemUserError("new@example.com"));
    const res = await app.request(
      "/admin/insight/system-users",
      {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com", role: "SystemAdmin" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(409);
  });

  it("TenantAdmin claim は 403", async () => {
    const res = await app.request(
      "/admin/insight/system-users",
      {
        method: "POST",
        body: JSON.stringify({ email: "new@example.com", role: "SystemAdmin" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(tenantAdminClaims) },
    );
    expect(res.status).toBe(403);
  });
});

describe("ADR-020 Phase C / #949: GET /admin/insight/system-users/:username", () => {
  beforeEach(() => vi.clearAllMocks());

  it("存在するなら 200 + detail を返すべき", async () => {
    mocks.getSystemUser.mockResolvedValueOnce({
      username: "u1@example.com",
      email: "u1@example.com",
      groups: ["SystemAdmin"],
    });
    const res = await app.request(
      "/admin/insight/system-users/u1@example.com",
      {},
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(200);
  });

  it("存在しないなら 404", async () => {
    const { SystemUserNotFoundError } = await import(
      "../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito"
    );
    mocks.getSystemUser.mockRejectedValueOnce(new SystemUserNotFoundError("u1@example.com"));
    const res = await app.request(
      "/admin/insight/system-users/u1@example.com",
      {},
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(404);
  });

  it("無効 username (= 不正文字含む) は 400", async () => {
    const res = await app.request(
      "/admin/insight/system-users/<bad>",
      {},
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(400);
  });
});

describe("ADR-020 Phase C / #949: PATCH /admin/insight/system-users/:username", () => {
  beforeEach(() => vi.clearAllMocks());

  it("role 変更が 200 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/system-users/other@example.com",
      {
        method: "PATCH",
        body: JSON.stringify({ role: "SystemAuditor" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(200);
  });

  it("自分自身を SystemAuditor に降格しようとすると 409 cannot_demote_self", async () => {
    const res = await app.request(
      "/admin/insight/system-users/admin@example.com",
      {
        method: "PATCH",
        body: JSON.stringify({ role: "SystemAuditor" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("cannot_demote_self");
  });

  it("存在しない user は 404", async () => {
    const { SystemUserNotFoundError } = await import(
      "../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito"
    );
    mocks.updateSystemUserRole.mockRejectedValueOnce(
      new SystemUserNotFoundError("ghost@example.com"),
    );
    const res = await app.request(
      "/admin/insight/system-users/ghost@example.com",
      {
        method: "PATCH",
        body: JSON.stringify({ role: "SystemAdmin" }),
        headers: { "Content-Type": "application/json" },
      },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(404);
  });
});

describe("ADR-020 Phase C / #949: DELETE /admin/insight/system-users/:username", () => {
  beforeEach(() => vi.clearAllMocks());

  it("他人の削除は 200 を返すべき", async () => {
    const res = await app.request(
      "/admin/insight/system-users/other@example.com",
      { method: "DELETE" },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(200);
  });

  it("自分自身の削除は 409 cannot_delete_self", async () => {
    const res = await app.request(
      "/admin/insight/system-users/admin@example.com",
      { method: "DELETE" },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("cannot_delete_self");
  });

  it("存在しない user は 404", async () => {
    const { SystemUserNotFoundError } = await import(
      "../../lib/admin-insight/handlers/admin-insight-handler/system-users-cognito"
    );
    mocks.deleteSystemUser.mockRejectedValueOnce(new SystemUserNotFoundError("ghost@example.com"));
    const res = await app.request(
      "/admin/insight/system-users/ghost@example.com",
      { method: "DELETE" },
      { event: withClaims(systemAdminClaims) },
    );
    expect(res.status).toBe(404);
  });

  it("TenantAdmin claim は 403", async () => {
    const res = await app.request(
      "/admin/insight/system-users/other@example.com",
      { method: "DELETE" },
      { event: withClaims(tenantAdminClaims) },
    );
    expect(res.status).toBe(403);
  });
});
