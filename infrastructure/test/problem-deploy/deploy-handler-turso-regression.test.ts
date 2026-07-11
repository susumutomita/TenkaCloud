import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlCompetitorAccountsRepository } from "../../lib/problem-deploy/control-data/competitor-accounts-repository";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/deployments-repository";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

/**
 * [Issue #2560] Regression test: `startDeployment` must succeed when
 * `CONTROL_DATA_BACKEND` is `turso`/`sql` (pure SQL) and every repository the
 * deploy path touches is resolved through the SQL seam. Before this fix,
 * `DeployApiLambda` was wired without `TURSO_DATABASE_URL` /
 * `TURSO_AUTH_TOKEN_PARAMETER_NAME`, so `acquireSqlExecutor()` threw at
 * runtime and every deploy/list/retry call failed — that CDK env/IAM wiring
 * bug itself is pinned by the synth assertion in
 * `control-data-backend-feature-flag.test.ts` (the actual red→green for
 * #2560), not by this file. This test instead exercises the repository
 * resolution seam (`controlDataRuntime`) `startDeployment` calls at request
 * time, swapped for a real in-memory SQLite-backed `SqlExecutor` (via
 * `makeSqliteExecutor`) instead of a real libSQL/SSM round-trip, to prove a
 * genuine SQL round-trip (deployment row actually written and readable back)
 * — not just that the env/IAM wiring exists.
 *
 * `resolveVerifiedCompetitorAccount` also resolves through the same seam in
 * pure SQL mode, so the fake must seed a verified competitor-account row too
 * (Fable review note) — omitting it would surface `UnverifiedCompetitorAccountError`
 * and mask the actual regression this test targets.
 *
 * [#2527 Slice 4] Every seam `startDeployment` reaches now resolves through the
 * per-context injected `ctx.runtime` — Deployments directly (see `shared.ts`) and
 * the verified competitor-account lookup via `deps.runtime`
 * (`competitor-account-lookup.ts`) — so `fakeRuntime` fakes both resolvers and no
 * module mock of `runtime-repositories` is needed.
 */
const sql = makeSqliteExecutor();
const deploymentsRepository = new SqlDeploymentsRepository(sql);
const competitorAccountsRepository = new SqlCompetitorAccountsRepository(sql);

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/presigned-url", () => ({
  generateChallengePayloadUrl: vi.fn(),
}));

const { startDeployment } = await import("../../lib/problem-deploy/handlers/deploy-handler/deploy");
type DeployContext = Parameters<typeof startDeployment>[0];
type DeployInvocation = Parameters<typeof startDeployment>[1];

const fakeRuntime = {
  resolveDeploymentsRepository: vi.fn().mockResolvedValue(deploymentsRepository),
  resolveCompetitorAccountsRepository: vi.fn().mockResolvedValue(competitorAccountsRepository),
} as unknown as DeployContext["runtime"];

describe("startDeployment against a pure SQL (turso/sql) control-data backend", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await competitorAccountsRepository.createAccount({
      tenantId: "tenant-acme",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
      verified: true,
      createdAt: "2026-07-08T12:00:00.000Z",
      updatedAt: "2026-07-08T12:00:00.000Z",
      createdBy: "user-sub-1",
    });
  });

  it("should create a deployment row through the SQL repository seam and publish DeployCreateRequested", async () => {
    const eventsSend = vi.fn().mockResolvedValue({});
    const ctx: DeployContext = {
      runtime: fakeRuntime,
      // Table names are unused in pure SQL mode (the repository seam never
      // touches ctx.ddb); kept non-empty only to match the DeployContext shape.
      tableName: "unused-in-pure-sql-mode",
      competitorAccountsTableName: "unused-in-pure-sql-mode",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: vi.fn() } as unknown as DeployContext["ddb"],
      events: { send: eventsSend } as unknown as DeployContext["events"],
      now: () => 1_700_000_000_000,
      ttlMs: 60_000,
      tenantId: "tenant-acme",
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    };
    const request: DeployInvocation = {
      problemId: "hello-world",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      teamName: "Alpha Team",
    };

    const response = await startDeployment(ctx, request);

    expect(response.status).toBe("PENDING");
    expect(eventsSend).toHaveBeenCalledOnce();

    const stored = await deploymentsRepository.getDeployment(response.jobId);
    expect(stored).toMatchObject({
      jobId: response.jobId,
      problemId: "hello-world",
      tenantId: "tenant-acme",
      awsAccountId: "123456789012",
      status: "PENDING",
    });
  });

  it("should reject with UnverifiedCompetitorAccountError when no verified row exists for the account (fail-closed preserved under SQL)", async () => {
    const { UnverifiedCompetitorAccountError } = await import(
      "../../lib/problem-deploy/handlers/deploy-handler/deploy"
    );
    const ctx: DeployContext = {
      runtime: fakeRuntime,
      tableName: "unused-in-pure-sql-mode",
      competitorAccountsTableName: "unused-in-pure-sql-mode",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: vi.fn() } as unknown as DeployContext["ddb"],
      events: { send: vi.fn().mockResolvedValue({}) } as unknown as DeployContext["events"],
      now: () => 1_700_000_000_000,
      ttlMs: 60_000,
      tenantId: "tenant-acme",
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    };
    const request: DeployInvocation = {
      problemId: "hello-world",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
      teamName: "Beta Team",
    };

    await expect(startDeployment(ctx, request)).rejects.toBeInstanceOf(
      UnverifiedCompetitorAccountError,
    );
  });
});
