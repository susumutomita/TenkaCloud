import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #948: 3 handler (deploy / event / competitor-accounts) の
 * route 単位 granular role gate を pin する test。
 *
 * 旧 broken-glass 規律 (= 全 route で TenantAdmin only) を、 次の matrix に置換した:
 *
 *   - GET (read) → Admin / Operator / Viewer 全部 OK
 *   - POST / PATCH (mutate) → Admin + Operator
 *   - DELETE / archive / lock-scoring (destructive) → Admin only
 *   - admin (= SAML config / user 管理) → Admin only
 *
 * Viewer も dropdown populate のため `/admin/competitor-accounts` の GET には pass する
 * (= EventCreate dropdown 空問題の解消、 issue 本文の persona mismatch fix)。
 *
 * test 経路は `app.request()` で JWT を bypass しているので、 各 test で
 * `DEFAULT_USER_ROLE` env を切り替えて role 差を再現する。
 */

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
});

const originalRole = process.env.DEFAULT_USER_ROLE;
afterEach(() => {
  if (originalRole === undefined) delete process.env.DEFAULT_USER_ROLE;
  else process.env.DEFAULT_USER_ROLE = originalRole;
});

const deployMocks = vi.hoisted(() => ({
  startDeployment: vi.fn(),
  listDeployments: vi.fn(),
  getDeployment: vi.fn(),
  requestTeardown: vi.fn(),
  retryDeployments: vi.fn(),
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
  getStackProgress: vi.fn(),
  defaultCfnClient: vi.fn(),
  defaultCfnClientForCompetitor: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  getEventDetail: vi.fn(),
  createEvent: vi.fn(),
  setEventSchedule: vi.fn(),
  endEvent: vi.fn(),
  lockScoring: vi.fn(),
  unlockScoring: vi.fn(),
  archiveEvent: vi.fn(),
  bulkDeployEvent: vi.fn(),
  bulkTeardownEvent: vi.fn(),
  rotateTeamLoginKey: vi.fn(),
  createNotification: vi.fn(),
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
vi.mock("../../lib/problem-deploy/handlers/event-handler/create", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/event-handler/create")
  >("../../lib/problem-deploy/handlers/event-handler/create");
  return {
    createEvent: eventMocks.createEvent,
    DuplicateInternalSlugError: actual.DuplicateInternalSlugError,
    DuplicateProblemIdError: actual.DuplicateProblemIdError,
  };
});
vi.mock("../../lib/problem-deploy/handlers/event-handler/schedule", () => ({
  setEventSchedule: eventMocks.setEventSchedule,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/end-event", () => ({
  endEvent: eventMocks.endEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/lock-scoring", () => ({
  lockScoring: eventMocks.lockScoring,
  unlockScoring: eventMocks.unlockScoring,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/archive", () => ({
  archiveEvent: eventMocks.archiveEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-deploy", () => ({
  bulkDeployEvent: eventMocks.bulkDeployEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-delete", () => ({
  bulkTeardownEvent: eventMocks.bulkTeardownEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/rotate-team-login-key", () => ({
  rotateTeamLoginKey: eventMocks.rotateTeamLoginKey,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/create-notification", () => ({
  createNotification: eventMocks.createNotification,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/disruption-fire", () => ({
  fireDisruption: eventMocks.fireDisruption,
  isEventOwnedByTenant: eventMocks.isEventOwnedByTenant,
  listDisruptionCatalog: eventMocks.listDisruptionCatalog,
  listDisruptionAudit: eventMocks.listDisruptionAudit,
}));

const competitorMocks = vi.hoisted(() => ({
  listCompetitorAccounts: vi.fn(),
  createCompetitorAccount: vi.fn(),
  deleteCompetitorAccount: vi.fn(),
  verifyCompetitorAccount: vi.fn(),
  routeGet: vi.fn(),
  routePut: vi.fn(),
  routeDelete: vi.fn(),
  routeListUsers: vi.fn(),
  routeCreateUser: vi.fn(),
  routeDeleteUser: vi.fn(),
  routeChangeUserRole: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/shared", () => ({
  buildCompetitorAccountsSharedResources: () => ({
    tableName: "TestCompetitorAccounts",
    ssmKeyPrefix: "/tenkacloud/test/competitor",
    region: "ap-northeast-1",
    ddb: { send: vi.fn() },
    ssm: { send: vi.fn() },
    sts: { send: vi.fn() },
    cognito: { send: vi.fn() },
    userPoolId: "test-pool",
  }),
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/store", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/competitor-accounts-handler/store")
  >("../../lib/problem-deploy/handlers/competitor-accounts-handler/store");
  return {
    listCompetitorAccounts: competitorMocks.listCompetitorAccounts,
    createCompetitorAccount: competitorMocks.createCompetitorAccount,
    deleteCompetitorAccount: competitorMocks.deleteCompetitorAccount,
    DuplicateCompetitorAccountError: actual.DuplicateCompetitorAccountError,
    CompetitorAccountNotFoundError: actual.CompetitorAccountNotFoundError,
    CompetitorAccountNotVerifiedError: actual.CompetitorAccountNotVerifiedError,
  };
});

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/verify", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/competitor-accounts-handler/verify")
  >("../../lib/problem-deploy/handlers/competitor-accounts-handler/verify");
  return {
    verifyCompetitorAccount: competitorMocks.verifyCompetitorAccount,
    ExternalIdMissingError: actual.ExternalIdMissingError,
    AssumeRoleSanityCheckFailedError: actual.AssumeRoleSanityCheckFailedError,
  };
});

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/saml-routes", () => ({
  routeGet: competitorMocks.routeGet,
  routePut: competitorMocks.routePut,
  routeDelete: competitorMocks.routeDelete,
}));

vi.mock("../../lib/problem-deploy/handlers/competitor-accounts-handler/users-routes", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/competitor-accounts-handler/users-routes")
  >("../../lib/problem-deploy/handlers/competitor-accounts-handler/users-routes");
  return {
    InviteUserRequestSchema: actual.InviteUserRequestSchema,
    ChangeRoleRequestSchema: actual.ChangeRoleRequestSchema,
    routeListUsers: competitorMocks.routeListUsers,
    routeCreateUser: competitorMocks.routeCreateUser,
    routeDeleteUser: competitorMocks.routeDeleteUser,
    routeChangeUserRole: competitorMocks.routeChangeUserRole,
  };
});

const { app: deployApp } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");
const { app: eventApp } = await import("../../lib/problem-deploy/handlers/event-handler/index");
const { app: competitorApp } = await import(
  "../../lib/problem-deploy/handlers/competitor-accounts-handler/index"
);

const ULID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";
const PROBLEM = "security-battle-royale";

beforeEach(() => {
  vi.clearAllMocks();
  // happy-path stubs so that pass-through routes reach the handler body without throwing
  deployMocks.startDeployment.mockResolvedValue({ jobId: ULID });
  deployMocks.listDeployments.mockResolvedValue({ items: [] });
  deployMocks.getDeployment.mockResolvedValue({ jobId: ULID, status: "IN_PROGRESS" });
  deployMocks.requestTeardown.mockResolvedValue({ kind: "already_deleted" });
  deployMocks.retryDeployments.mockResolvedValue({ items: [] });

  eventMocks.listEvents.mockResolvedValue({ items: [] });
  eventMocks.getEventDetail.mockResolvedValue({ id: ULID });
  eventMocks.createEvent.mockResolvedValue({ id: ULID });
  eventMocks.setEventSchedule.mockResolvedValue({ kind: "no_op" });
  eventMocks.endEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.lockScoring.mockResolvedValue({ kind: "not_found" });
  eventMocks.unlockScoring.mockResolvedValue({ kind: "not_found" });
  eventMocks.archiveEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.bulkDeployEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.bulkTeardownEvent.mockResolvedValue({ kind: "not_found" });
  eventMocks.createNotification.mockResolvedValue({ kind: "not_found" });
  eventMocks.fireDisruption.mockResolvedValue({ kind: "unknown_problem" });
  eventMocks.isEventOwnedByTenant.mockResolvedValue(true);
  eventMocks.listDisruptionCatalog.mockResolvedValue({ items: [] });
  eventMocks.listDisruptionAudit.mockResolvedValue({ items: [] });

  competitorMocks.listCompetitorAccounts.mockResolvedValue([]);
  competitorMocks.createCompetitorAccount.mockResolvedValue({ awsAccountId: "123456789012" });
  competitorMocks.deleteCompetitorAccount.mockResolvedValue(undefined);
  competitorMocks.verifyCompetitorAccount.mockResolvedValue({ awsAccountId: "123456789012" });
  competitorMocks.routeGet.mockResolvedValue({ status: 200, body: {} });
  competitorMocks.routePut.mockResolvedValue({ status: 200, body: {} });
  competitorMocks.routeDelete.mockResolvedValue({ status: 200, body: {} });
  competitorMocks.routeListUsers.mockResolvedValue({ status: 200, body: { items: [] } });
  competitorMocks.routeCreateUser.mockResolvedValue({ status: 201, body: {} });
  competitorMocks.routeDeleteUser.mockResolvedValue({ status: 200, body: {} });
  competitorMocks.routeChangeUserRole.mockResolvedValue({ status: 200, body: {} });
});

async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("forbidden_role");
}

async function expectNotForbidden(res: Response): Promise<void> {
  expect(res.status).not.toBe(403);
}

describe("deploy-handler route role gates (#948)", () => {
  describe("TenantViewer (= read-only)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantViewer";
    });

    it("GET /problems/:id/deployments should return 200 (Viewer should also pass for dropdown population)", async () => {
      const res = await deployApp.request(`/problems/${PROBLEM}/deployments`);
      expect(res.status).toBe(200);
    });

    it("GET /deployments/:jobId should pass", async () => {
      const res = await deployApp.request(`/deployments/${ULID}`);
      await expectNotForbidden(res);
    });

    it("POST /problems/:id/deploy should return 403 forbidden_role", async () => {
      const res = await deployApp.request(`/problems/${PROBLEM}/deploy`, {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });

    it("POST /deployments/retry should return 403", async () => {
      const res = await deployApp.request("/deployments/retry", {
        method: "POST",
        body: JSON.stringify({ failedJobIds: [ULID] }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });

    it("DELETE /deployments/:jobId should return 403", async () => {
      const res = await deployApp.request(`/deployments/${ULID}`, { method: "DELETE" });
      await expectForbidden(res);
    });
  });

  describe("TenantOperator (= mutate OK + destructive OK)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantOperator";
    });

    it("POST /problems/:id/deploy は pass する (= mutate 可)", async () => {
      const res = await deployApp.request(`/problems/${PROBLEM}/deploy`, {
        method: "POST",
        body: JSON.stringify({
          region: "ap-northeast-1",
          awsAccountId: "123456789012",
          teamName: "T",
        }),
        headers: { "Content-Type": "application/json" },
      });
      await expectNotForbidden(res);
    });

    it("DELETE /deployments/:jobId は pass する (= 個別 teardown は Operator も可)", async () => {
      const res = await deployApp.request(`/deployments/${ULID}`, { method: "DELETE" });
      await expectNotForbidden(res);
    });
  });

  describe("TenantAdmin (= everything OK)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    });

    it("DELETE /deployments/:jobId は pass", async () => {
      const res = await deployApp.request(`/deployments/${ULID}`, { method: "DELETE" });
      await expectNotForbidden(res);
    });
  });

  describe("unknown role (= claim 不在)", () => {
    beforeEach(() => {
      delete process.env.DEFAULT_USER_ROLE;
    });

    it("GET は 403 になる (= 認証済 user として扱われない、 fail-closed)", async () => {
      const res = await deployApp.request(`/problems/${PROBLEM}/deployments`);
      await expectForbidden(res);
    });
  });
});

describe("event-handler route role gates (#948)", () => {
  describe("TenantViewer", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantViewer";
    });

    it("GET /events は 200 (= 観覧 OK)", async () => {
      const res = await eventApp.request("/events");
      expect(res.status).toBe(200);
    });

    it("GET /events/:id は credential の再読込 option 無しで pass する", async () => {
      const res = await eventApp.request(`/events/${ULID}`);
      await expectNotForbidden(res);
      expect(eventMocks.getEventDetail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        ULID,
        { withScoreEvents: false, withTeamLoginKeys: false },
      );
    });

    it("GET /events/:id?withTeamLoginKeys=true は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}?withTeamLoginKeys=true`);
      await expectForbidden(res);
      expect(eventMocks.getEventDetail).not.toHaveBeenCalled();
    });

    it("GET /events/:id/disruptions は pass (= disruption catalog 観覧)", async () => {
      const res = await eventApp.request(`/events/${ULID}/disruptions`);
      await expectNotForbidden(res);
    });

    it("POST /events は 403 (= 作成は Admin/Operator)", async () => {
      const res = await eventApp.request("/events", {
        method: "POST",
        body: JSON.stringify({
          internalSlug: "x",
          displayName: "X",
          competitorAccounts: [{ awsAccountId: "123456789012", teamName: "T" }],
          problemIds: ["security-battle-royale"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });

    it("PATCH /events/:id/schedule は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}/schedule`, {
        method: "PATCH",
        body: JSON.stringify({ startNow: true }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });

    it("DELETE /events/:id は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}`, { method: "DELETE" });
      await expectForbidden(res);
    });

    it("POST /events/:id/archive は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}/archive`, { method: "POST" });
      await expectForbidden(res);
    });

    it("POST /events/:id/lock-scoring は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}/lock-scoring`, { method: "POST" });
      await expectForbidden(res);
    });

    it("POST /events/:id/teams/:teamId/rotate-login-key は 403", async () => {
      const res = await eventApp.request(`/events/${ULID}/teams/${ULID}/rotate-login-key`, {
        method: "POST",
      });
      await expectForbidden(res);
    });
  });

  describe("TenantOperator (= mutate OK, destructive NG)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantOperator";
    });

    it("POST /events は pass (= Operator も event 作成 OK)", async () => {
      const res = await eventApp.request("/events", {
        method: "POST",
        body: JSON.stringify({
          internalSlug: "x",
          displayName: "X",
          competitorAccounts: [{ awsAccountId: "123456789012", teamName: "T" }],
          problemIds: ["security-battle-royale"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      await expectNotForbidden(res);
    });

    it("POST /events/:id/deploy (bulk) は pass", async () => {
      const res = await eventApp.request(`/events/${ULID}/deploy`, {
        method: "POST",
        body: "",
      });
      await expectNotForbidden(res);
    });

    it("POST /events/:id/teams/:teamId/rotate-login-key は pass", async () => {
      eventMocks.rotateTeamLoginKey.mockResolvedValueOnce({
        kind: "ok",
        teamId: ULID,
        teamLoginKey: "NEW-KEY",
        rotatedAt: "2026-07-15T00:00:00.000Z",
      });
      const res = await eventApp.request(`/events/${ULID}/teams/${ULID}/rotate-login-key`, {
        method: "POST",
      });
      await expectNotForbidden(res);
    });

    it("GET /events/:id は opt-in で保存済み credential を再読込できる", async () => {
      const res = await eventApp.request(`/events/${ULID}?withTeamLoginKeys=true`);
      await expectNotForbidden(res);
      expect(eventMocks.getEventDetail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        ULID,
        { withScoreEvents: false, withTeamLoginKeys: true },
      );
    });

    it("POST /events/:id/disruptions/fire は pass", async () => {
      const res = await eventApp.request(`/events/${ULID}/disruptions/fire`, {
        method: "POST",
        body: JSON.stringify({
          problemId: "security-battle-royale",
          disruptionId: "test-disruption",
          requestId: ULID,
          scope: "single",
          targetTeamIds: ["t1"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      await expectNotForbidden(res);
    });

    it("DELETE /events/:id は 403 (= destructive bulk teardown は Admin のみ)", async () => {
      const res = await eventApp.request(`/events/${ULID}`, { method: "DELETE" });
      await expectForbidden(res);
    });

    it("POST /events/:id/archive は 403 (= archive は Admin のみ)", async () => {
      const res = await eventApp.request(`/events/${ULID}/archive`, { method: "POST" });
      await expectForbidden(res);
    });

    it("POST /events/:id/lock-scoring は 403 (= scoring lock は Admin のみ)", async () => {
      const res = await eventApp.request(`/events/${ULID}/lock-scoring`, { method: "POST" });
      await expectForbidden(res);
    });
  });

  describe("TenantAdmin (= everything OK)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    });

    it("DELETE /events/:id は pass", async () => {
      const res = await eventApp.request(`/events/${ULID}`, { method: "DELETE" });
      await expectNotForbidden(res);
    });

    it("POST /events/:id/archive は pass", async () => {
      const res = await eventApp.request(`/events/${ULID}/archive`, { method: "POST" });
      await expectNotForbidden(res);
    });

    it("POST /events/:id/lock-scoring は pass", async () => {
      const res = await eventApp.request(`/events/${ULID}/lock-scoring`, { method: "POST" });
      await expectNotForbidden(res);
    });
  });
});

describe("competitor-accounts-handler route role gates (#948)", () => {
  describe("TenantViewer (= dropdown populate のため list には pass)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantViewer";
    });

    it("GET /admin/competitor-accounts は 200 (= EventCreate dropdown 用)", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts");
      expect(res.status).toBe(200);
    });

    it("POST /admin/competitor-accounts は 403 (= 新規登録は Admin)", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts", {
        method: "POST",
        body: JSON.stringify({ awsAccountId: "123456789012", teamName: "T" }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });

    it("DELETE /admin/competitor-accounts/:id は 403", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts/123456789012", {
        method: "DELETE",
      });
      await expectForbidden(res);
    });

    it("GET /admin/tenant-saml-config は 403 (= SAML 設定は Admin)", async () => {
      const res = await competitorApp.request("/admin/tenant-saml-config");
      await expectForbidden(res);
    });
  });

  describe("TenantOperator", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantOperator";
    });

    it("GET /admin/competitor-accounts は pass (= Operator も dropdown 使う)", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts");
      await expectNotForbidden(res);
    });

    it("POST /admin/competitor-accounts は 403 (= Admin 限定)", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts", {
        method: "POST",
        body: JSON.stringify({ awsAccountId: "123456789012", teamName: "T" }),
        headers: { "Content-Type": "application/json" },
      });
      await expectForbidden(res);
    });
  });

  describe("TenantAdmin (= everything OK)", () => {
    beforeEach(() => {
      process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    });

    it("POST /admin/competitor-accounts は pass", async () => {
      const res = await competitorApp.request("/admin/competitor-accounts", {
        method: "POST",
        body: JSON.stringify({ awsAccountId: "123456789012", teamName: "T" }),
        headers: { "Content-Type": "application/json" },
      });
      await expectNotForbidden(res);
    });
  });
});

describe("Issue #2200: event-handler /admin/* blanket role guard", () => {
  it("GET /admin/audit-log は TenantViewer で 403 (= blanket guard が fail-closed)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";
    const res = await eventApp.request("/admin/audit-log");
    await expectForbidden(res);
  });

  it("GET /admin/audit-log/export は TenantOperator で 403", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantOperator";
    const res = await eventApp.request("/admin/audit-log/export");
    await expectForbidden(res);
  });

  it("GET /admin/audit-log は TenantAdmin で pass (= 既存挙動不変)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantAdmin";
    const res = await eventApp.request("/admin/audit-log");
    await expectNotForbidden(res);
  });

  it("route 未定義の /admin/* も handler 到達前に 403 (= 将来の requireRole 書き忘れ耐性)", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";
    const res = await eventApp.request("/admin/does-not-exist");
    await expectForbidden(res);
  });
});
