import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #2948 / ADR-0005 Phase 1: machine (M2M) principal に対する **構造的封じ込め** の証明。
 *
 * この test の中核は 2 つある。
 *
 * 1. **T-4**: machine claims では destructive route が全部 403 になる。しかも guard middleware を
 *    外した状態でも 403 になる — つまり deny しているのは middleware ではなく `TenantMachine`
 *    role そのものであり、middleware は 2 枚目の防壁にすぎない。
 * 2. **T-5**: Phase 1 allowlist の 7 route は通り、human claims / env fallback 経路の挙動は
 *    一切変わらない。
 *
 * `app.request(path, init, env)` の第 3 引数で `c.env.event` を差し込み、API Gateway の
 * Cognito authorizer が付ける claims を再現する。
 */

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
});

const originalRole = process.env.DEFAULT_USER_ROLE;
const originalTenant = process.env.DEFAULT_TENANT_ID;
afterEach(() => {
  if (originalRole === undefined) delete process.env.DEFAULT_USER_ROLE;
  else process.env.DEFAULT_USER_ROLE = originalRole;
  if (originalTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = originalTenant;
});

const deployMocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  retryDeployments: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  getStackProgress: vi.fn(),
}));

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
    startDeployment: deployMocks.startDeployment,
    UnknownProblemError: actual.UnknownProblemError,
    UnverifiedCompetitorAccountError: actual.UnverifiedCompetitorAccountError,
  };
});
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/list", () => ({
  listDeployments: deployMocks.listDeployments,
  getDeployment: deployMocks.getDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/delete", () => ({
  requestTeardown: deployMocks.requestTeardown,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/retry", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/deploy-handler/retry")
  >("../../lib/problem-deploy/handlers/deploy-handler/retry");
  return {
    retryDeployments: deployMocks.retryDeployments,
    validateRetryRequest: actual.validateRetryRequest,
    InvalidRetryRequestError: actual.InvalidRetryRequestError,
  };
});
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/stack-progress", () => ({
  getStackProgress: deployMocks.getStackProgress,
  defaultCfnClient: vi.fn(),
  defaultCfnClientForCompetitor: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  getEventDetail: vi.fn(),
  setEventSchedule: vi.fn(),
  endEvent: vi.fn(),
  archiveEvent: vi.fn(),
  bulkTeardownEvent: vi.fn(),
  bulkDeployEvent: vi.fn(),
  rotateTeamLoginKey: vi.fn(),
  fireDisruption: vi.fn(),
  isEventOwnedByTenant: vi.fn(),
  listDisruptionCatalog: vi.fn(),
  listDisruptionAudit: vi.fn(),
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
vi.mock("../../lib/problem-deploy/handlers/event-handler/schedule", () => ({
  setEventSchedule: eventMocks.setEventSchedule,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/end-event", () => ({
  endEvent: eventMocks.endEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/archive", () => ({
  archiveEvent: eventMocks.archiveEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-delete", () => ({
  bulkTeardownEvent: eventMocks.bulkTeardownEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-deploy", () => ({
  bulkDeployEvent: eventMocks.bulkDeployEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/rotate-team-login-key", () => ({
  rotateTeamLoginKey: eventMocks.rotateTeamLoginKey,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/disruption-fire", () => ({
  fireDisruption: eventMocks.fireDisruption,
  isEventOwnedByTenant: eventMocks.isEventOwnedByTenant,
  listDisruptionCatalog: eventMocks.listDisruptionCatalog,
  listDisruptionAudit: eventMocks.listDisruptionAudit,
}));

const auditMocks = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/shared/audit-log", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/shared/audit-log")
  >("../../lib/problem-deploy/handlers/shared/audit-log");
  return { ...actual, writeAuditEvent: auditMocks.writeAuditEvent };
});

const { app: deployApp } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
const { app: eventApp } = await import("../../lib/problem-deploy/handlers/event-handler/index");
const {
  requireRole,
  TENANT_ADMIN_ROLE,
  TENANT_BLANKET_ROLES,
  TENANT_MACHINE_ROLE,
  TENANT_OPERATOR_ROLE,
} = await import("../../lib/problem-deploy/handlers/deploy-handler/auth");
const { createMachineGuardMiddleware } = await import(
  "../../lib/problem-deploy/handlers/shared/machine-principal"
);
const { buildAuthErrorHandler, createRoleCheckMiddleware } = await import(
  "../../lib/problem-deploy/handlers/shared/auth-wiring"
);
const { bindScope, capabilityScope, MACHINE_CAPABILITIES, MACHINE_ROUTE_SCOPES } = await import(
  "../../lib/problem-deploy/handlers/shared/machine-scopes"
);
type MachineCapability = (typeof MACHINE_CAPABILITIES)[number];

const TENANT = "01JABCDEF0123456789ABCDEF";
const ULID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";
const PROBLEM = "security-battle-royale";

/** API Gateway + Cognito authorizer が付ける claims を `c.env.event` に載せる。 */
function envWithClaims(claims: Record<string, string>) {
  return { event: { requestContext: { authorizer: { claims } } } };
}

function machineEnv(capabilities: readonly MachineCapability[] = MACHINE_CAPABILITIES) {
  return envWithClaims({
    token_use: "access",
    client_id: "machine-client-1",
    scope: `${capabilities.map(capabilityScope).join(" ")} ${bindScope(TENANT)}`,
  });
}

function humanEnv(role: string) {
  return envWithClaims({
    "custom:tenantId": TENANT,
    "custom:userRole": role,
    sub: "cognito-sub-1",
    "cognito:username": "operator@example.com",
    token_use: "id",
  });
}

const JSON_HEADERS = { "Content-Type": "application/json" };

beforeEach(() => {
  vi.clearAllMocks();
  auditMocks.writeAuditEvent.mockResolvedValue(true);
  deployMocks.startDeployment.mockResolvedValue({ jobId: ULID });
  deployMocks.listDeployments.mockResolvedValue({ items: [] });
  deployMocks.getDeployment.mockResolvedValue({ jobId: ULID, status: "IN_PROGRESS" });
  deployMocks.requestTeardown.mockResolvedValue({ kind: "already_deleted" });
  deployMocks.getStackProgress.mockResolvedValue({ kind: "not_found" });
  deployMocks.retryDeployments.mockResolvedValue({ items: [] });

  eventMocks.listEvents.mockResolvedValue({ items: [] });
  eventMocks.getEventDetail.mockResolvedValue({ id: ULID });
  eventMocks.setEventSchedule.mockResolvedValue({ kind: "no_op" });
  eventMocks.endEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.archiveEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.bulkTeardownEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.bulkDeployEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.rotateTeamLoginKey.mockResolvedValue({ kind: "not_found" });
  eventMocks.fireDisruption.mockResolvedValue({ kind: "unknown_problem" });
  eventMocks.isEventOwnedByTenant.mockResolvedValue(true);
  eventMocks.listDisruptionCatalog.mockResolvedValue({ items: [] });
  eventMocks.listDisruptionAudit.mockResolvedValue({ items: [] });
});

/** Phase 1 で machine から到達できてはならない route の代表。 */
const DESTRUCTIVE_ROUTES: ReadonlyArray<{
  readonly app: "deploy" | "event";
  readonly method: string;
  readonly path: string;
}> = [
  { app: "deploy", method: "DELETE", path: `/deployments/${ULID}` },
  { app: "event", method: "POST", path: `/events/${ULID}/disruptions/fire` },
  { app: "event", method: "POST", path: `/events/${ULID}/teams/team-a/rotate-login-key` },
  { app: "event", method: "PATCH", path: `/events/${ULID}/schedule` },
  { app: "event", method: "POST", path: `/events/${ULID}/end` },
  { app: "event", method: "POST", path: `/events/${ULID}/archive` },
  { app: "event", method: "POST", path: `/events/${ULID}/deploy` },
  { app: "event", method: "DELETE", path: `/events/${ULID}` },
  { app: "event", method: "PUT", path: "/admin/feature-flags" },
  { app: "event", method: "GET", path: "/admin/audit-log" },
  { app: "event", method: "GET", path: "/admin/capacity" },
  { app: "event", method: "GET", path: "/feature-flags" },
];

describe("#2948 T-4: destructive routes are structurally unreachable for a machine principal", () => {
  it.each(DESTRUCTIVE_ROUTES)("should return 403 for $method $path", async ({
    app,
    method,
    path,
  }) => {
    const target = app === "deploy" ? deployApp : eventApp;
    const res = await target.request(
      path,
      { method, body: method === "GET" ? undefined : "{}", headers: JSON_HEADERS },
      machineEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("should still deny a destructive route when the guard middleware is removed entirely", async () => {
    // guard を外し、blanket (`TENANT_BLANKET_ROLES`) と per-route `requireRole` だけを残した app。
    // machine principal は guard が publish しないため role は解決されず、per-route の human 3 値
    // allowlist で落ちる。さらに guard 相当の principal を publish した場合でも
    // `TenantMachine` はどの allowlist にも含まれないので落ちる。この 2 つが「role が
    // load-bearing である」ことの証明である。
    const withoutGuard = new Hono();
    withoutGuard.onError(buildAuthErrorHandler({ logPrefix: "[test]" }));
    withoutGuard.use(
      "*",
      createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_BLANKET_ROLES }),
    );
    withoutGuard.delete("/deployments/:jobId", (c) => {
      requireRole(c, [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]);
      return c.json({ reached: true });
    });

    delete process.env.DEFAULT_USER_ROLE;
    const res = await withoutGuard.request(
      `/deployments/${ULID}`,
      { method: "DELETE" },
      machineEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("should reject TenantMachine from every human requireRole allowlist", () => {
    const machineContext = {
      env: machineEnv().event ? { event: machineEnv().event } : undefined,
      get: () => ({ tenantId: TENANT, clientId: "c", capabilities: new Set(["read", "deploy"]) }),
    };
    delete process.env.DEFAULT_USER_ROLE;
    for (const allowlist of [
      [TENANT_ADMIN_ROLE],
      [TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE],
      ["TenantAdmin", "TenantOperator", "TenantViewer"],
    ]) {
      expect(() =>
        requireRole(machineContext as unknown as Parameters<typeof requireRole>[0], allowlist),
      ).toThrow();
    }
  });

  it("should never expose the string TenantOperator or TenantAdmin as a machine role", () => {
    expect(TENANT_MACHINE_ROLE).toBe("TenantMachine");
    expect(TENANT_BLANKET_ROLES).toContain(TENANT_MACHINE_ROLE);
    expect([TENANT_ADMIN_ROLE, TENANT_OPERATOR_ROLE]).not.toContain(TENANT_MACHINE_ROLE);
  });
});

describe("#2948 T-5: the Phase 1 allowlist is reachable and the human path is unchanged", () => {
  it("should pass every allowlisted route for a machine token carrying the required capability", async () => {
    for (const route of MACHINE_ROUTE_SCOPES) {
      const path = route.honoPath
        .replace(":jobId", ULID)
        .replace(":eventId", ULID)
        .replace(":problemId", PROBLEM);
      const target = route.apigwPath.startsWith("/events") ? eventApp : deployApp;
      const res = await target.request(
        path,
        {
          method: route.method,
          ...(route.method === "POST"
            ? {
                body: JSON.stringify({
                  region: "ap-northeast-1",
                  awsAccountId: "123456789012",
                  teamName: "T",
                }),
                headers: JSON_HEADERS,
              }
            : {}),
        },
        machineEnv(),
      );
      expect(res.status, `${route.method} ${path}`).not.toBe(403);
    }
  });

  it("should deny an allowlisted route when the token lacks the required capability", async () => {
    const res = await deployApp.request(
      `/problems/${PROBLEM}/deploy`,
      {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: JSON_HEADERS,
      },
      machineEnv(["read"]),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden_machine_route");
  });

  it("should leave the human ID token path byte-identical (TenantOperator can still deploy)", async () => {
    const res = await deployApp.request(
      `/problems/${PROBLEM}/deploy`,
      {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: JSON_HEADERS,
      },
      humanEnv("TenantOperator"),
    );
    expect(res.status).toBe(202);
  });

  it("should keep destructive routes working for a human TenantAdmin", async () => {
    const res = await deployApp.request(
      `/deployments/${ULID}`,
      { method: "DELETE" },
      humanEnv("TenantAdmin"),
    );
    expect(res.status).toBe(200);
  });
});

describe("#2948 T-6: withTeamLoginKeys is denied for machine principals", () => {
  it("should return 403 forbidden_machine_route for a machine token", async () => {
    const res = await eventApp.request(
      `/events/${ULID}?withTeamLoginKeys=true`,
      undefined,
      machineEnv(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden_machine_route");
  });

  it("should still allow a human TenantOperator", async () => {
    const res = await eventApp.request(
      `/events/${ULID}?withTeamLoginKeys=true`,
      undefined,
      humanEnv("TenantOperator"),
    );
    expect(res.status).toBe(200);
  });
});

describe("#2948 T-7 / T-8: env fallback never rescues a machine principal", () => {
  it("should ignore DEFAULT_TENANT_ID and DEFAULT_USER_ROLE for a machine token (terminal branch)", async () => {
    process.env.DEFAULT_TENANT_ID = "sneaky";
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    // env が TenantAdmin を主張していても destructive route は通らない。
    const denied = await eventApp.request(`/events/${ULID}`, { method: "DELETE" }, machineEnv());
    expect(denied.status).toBe(403);
    // 許可 route では tenant が env の "sneaky" ではなく bind scope の tenant になる。
    await deployApp.request("/deployments", undefined, machineEnv());
    expect(deployMocks.listDeployments).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it("should deny machine claims on an app that never mounted the guard (unregistered != allowed)", async () => {
    const unguarded = new Hono();
    unguarded.onError(buildAuthErrorHandler({ logPrefix: "[test]" }));
    unguarded.use(
      "*",
      createRoleCheckMiddleware({ healthzPath: "/healthz", roles: TENANT_BLANKET_ROLES }),
    );
    unguarded.get("/deployments", (c) => c.json({ reached: true }));
    delete process.env.DEFAULT_USER_ROLE;

    const res = await unguarded.request("/deployments", undefined, machineEnv());
    expect(res.status).toBe(403);
  });

  it("should let the guard publish the principal only after every check passed", async () => {
    const app = new Hono();
    app.onError(buildAuthErrorHandler({ logPrefix: "[test]" }));
    app.use("*", createMachineGuardMiddleware());
    app.get("/deployments", (c) => c.json({ principal: c.get("machinePrincipal") ?? null }));
    app.get("/not-allowlisted", (c) => c.json({ principal: c.get("machinePrincipal") ?? null }));

    const allowed = await app.request("/deployments", undefined, machineEnv());
    expect(((await allowed.json()) as { principal: { tenantId: string } }).principal.tenantId).toBe(
      TENANT,
    );
    const denied = await app.request("/not-allowlisted", undefined, machineEnv());
    expect(denied.status).toBe(403);
  });
});

describe("#2948 T-11: machine mutations and denials reach the admin audit log", () => {
  it("should write a deploy_problem audit row for a machine deploy", async () => {
    const res = await deployApp.request(
      `/problems/${PROBLEM}/deploy`,
      {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: JSON_HEADERS,
      },
      machineEnv(),
    );
    expect(res.status).toBe(202);
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actor: "m2m:machine-client-1",
        action: "deploy_problem",
        outcome: "success",
        target: PROBLEM,
      }),
    );
  });

  it("should write a forbidden audit row when the guard denies a machine request", async () => {
    const res = await deployApp.request(`/deployments/${ULID}`, { method: "DELETE" }, machineEnv());
    expect(res.status).toBe(403);
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actor: "m2m:machine-client-1",
        outcome: "forbidden",
        action: `DELETE /deployments/${ULID}`,
        target: "route_not_allowlisted",
      }),
    );
  });

  it("should write a deploy_problem audit row for a human deploy too (same granularity)", async () => {
    await deployApp.request(
      `/problems/${PROBLEM}/deploy`,
      {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: JSON_HEADERS,
      },
      humanEnv("TenantOperator"),
    );
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "cognito-sub-1",
        actorUsername: "operator@example.com",
        action: "deploy_problem",
        outcome: "success",
      }),
    );
  });
});

describe("#2955: POST /deployments/retry is the second machine mutating route", () => {
  const RETRY_BODY = JSON.stringify({ failedJobIds: [ULID] });

  it("should allow a machine token that carries the write capability", async () => {
    const res = await deployApp.request(
      "/deployments/retry",
      { method: "POST", body: RETRY_BODY, headers: JSON_HEADERS },
      machineEnv(["read", "write"]),
    );
    expect(res.status).toBe(200);
    expect(deployMocks.retryDeployments).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ failedJobIds: [ULID] }),
    );
  });

  it("should reject a deploy-only token (write is a separate capability on purpose)", async () => {
    const res = await deployApp.request(
      "/deployments/retry",
      { method: "POST", body: RETRY_BODY, headers: JSON_HEADERS },
      machineEnv(["read", "deploy"]),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden_machine_route");
    expect(deployMocks.retryDeployments).not.toHaveBeenCalled();
  });

  it("should write a retry_deployments audit row", async () => {
    await deployApp.request(
      "/deployments/retry",
      { method: "POST", body: RETRY_BODY, headers: JSON_HEADERS },
      machineEnv(["read", "write"]),
    );
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actor: "m2m:machine-client-1",
        action: "retry_deployments",
        outcome: "success",
      }),
    );
  });

  it("should keep working for a human TenantOperator", async () => {
    const res = await deployApp.request(
      "/deployments/retry",
      { method: "POST", body: RETRY_BODY, headers: JSON_HEADERS },
      humanEnv("TenantOperator"),
    );
    expect(res.status).toBe(200);
  });
});
