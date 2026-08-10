/**
 * [Composite Runtime / Issue #2075] End-to-end handler test for routing a
 * `runtime.kind=composite` deploy request through the deploy API.
 *
 * The real Hono route + the real `startCompositeDeployment` orchestrator run;
 * only the materialize / dispatch / quota COLLABORATORS are injected (per the
 * issue: "Inject the materialize/dispatch collaborators so the handler test runs
 * without real cloud"). The composite descriptor is resolved from the baked
 * catalog env (`BATTLE_PROBLEMS_RUNTIMES`), so the route's composite-vs-legacy
 * fork is exercised exactly as in production.
 *
 * Legacy / single-provider requests are asserted to keep hitting the untouched
 * `startDeployment` path with the existing required-AWS request contract.
 */

import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set at MODULE scope (before the top-level `await import` of the handler) so the
// module-scope `buildSharedResources()` bakes the composite descriptor resolver
// from this env. `beforeAll` would run too late (after collection-time import).
process.env.DEFAULT_TENANT_ID = "tenant-acme";
process.env.DEFAULT_USER_ROLE = "TenantAdmin";
// Baked catalog runtime metadata: a four-provider composite, an Azure+Sakura
// (no-AWS) composite, and a single GCP problem.
process.env.BATTLE_PROBLEMS_RUNTIMES = JSON.stringify({
  "cross-cloud": {
    kind: "composite",
    targets: [
      { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
      { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://bucket/worker" },
      { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
      { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
    ],
  },
  "no-aws-composite": {
    kind: "composite",
    targets: [
      { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
      { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
    ],
  },
  "gcp-only": { provider: "gcp", engine: "infra-manager", entry: "gs://bucket/cfg" },
});

// Spies shared between the wiring mock and the assertions.
const spies = vi.hoisted(() => ({
  materialize: vi.fn(),
  dispatch: vi.fn(),
  enforceQuota: vi.fn(),
  startDeployment: vi.fn(),
  resolveIdempotencyRepository: vi.fn(),
}));

// Mock the production composite wiring so `buildCompositeDeployDeps` returns the
// injected collaborators, while the REAL `startCompositeDeployment` runs (its
// plan build, aws-required guard, quota-once, response shape are all exercised).
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/composite-deploy-wiring", async () => {
  const { buildCompositeDeploymentPlan } = await import("@tenkacloud/problem-runtime");
  return {
    buildCompositeDeployDeps: (ctx: { tenantId: string }) => ({
      buildPlan: buildCompositeDeploymentPlan,
      tenantId: ctx.tenantId,
      enforceQuota: spies.enforceQuota,
      materialize: spies.materialize,
      dispatch: spies.dispatch,
    }),
  };
});

// Keep the real error classes; only replace `startDeployment` so we can assert
// the legacy fork lands on it untouched. `buildSharedResources` injects a
// minimal context that still carries the real descriptor resolver.
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/deploy", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const { makeProblemRuntimeDescriptorResolver } = await import(
    "../../lib/problem-deploy/handlers/shared/runtime/index"
  );
  return {
    ...actual,
    buildSharedResources: () => ({
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: vi.fn() },
      events: { send: vi.fn() },
      ssm: { send: vi.fn() },
      problemsCatalog: { "cross-cloud": "problems/x", "no-aws-composite": "problems/y" },
      resolveProblemRuntimeDescriptor: makeProblemRuntimeDescriptorResolver(
        process.env.BATTLE_PROBLEMS_RUNTIMES,
      ),
    }),
    buildContext: (shared: unknown, tenantId: string) => ({ ...(shared as object), tenantId }),
    startDeployment: spies.startDeployment,
  };
});

// [Issue #3002] composite も同じ route を通るので、 記録しないとここだけ再送で二重に走る。
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/shared", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/problem-deploy/handlers/deploy-handler/shared")
  >("../../lib/problem-deploy/handlers/deploy-handler/shared");
  return { ...actual, resolveIdempotencyRepository: spies.resolveIdempotencyRepository };
});

const { app } = await import("../../lib/problem-deploy/handlers/deploy-handler/index");

const PARENT_ID = "parent-1";
const VALID_AWS = { region: "ap-northeast-1", awsAccountId: "123456789012", teamName: "Alpha" };

function dispatchResult(targetIds: readonly string[]) {
  return {
    parentDeploymentId: PARENT_ID,
    targets: targetIds.map((id, i) => ({
      targetId: id,
      targetDeploymentId: `td-${i}`,
      outcome: "started" as const,
    })),
  };
}

function materializeResult() {
  return {
    parentDeploymentId: PARENT_ID,
    teamLoginKey: "KEY1",
    targetDeploymentIds: {},
    expiresAt: 1_700_000_028_800,
  };
}

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  spies.materialize.mockResolvedValue(materializeResult());
  spies.enforceQuota.mockResolvedValue(undefined);
});

describe("POST /problems/:problemId/deploy — composite routing (#2075)", () => {
  it("should route a composite runtime to materialization and target dispatch", async () => {
    spies.dispatch.mockResolvedValue(
      dispatchResult(["aws-api", "gcp-worker", "azure-edge", "sakura-svc"]),
    );

    const res = await post("/problems/cross-cloud/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(spies.materialize).toHaveBeenCalledOnce();
    expect(spies.dispatch).toHaveBeenCalledOnce();
    // The legacy single-provider path was NOT taken.
    expect(spies.startDeployment).not.toHaveBeenCalled();
    // The four-provider plan was materialized in declared order.
    const plan = spies.materialize.mock.calls[0][0].plan;
    expect(plan.targets.map((t: { provider: string }) => t.provider)).toEqual([
      "aws",
      "gcp",
      "azure",
      "sakura",
    ]);
  });

  it("should return parent job id in the existing response shape", async () => {
    spies.dispatch.mockResolvedValue(
      dispatchResult(["aws-api", "gcp-worker", "azure-edge", "sakura-svc"]),
    );

    const res = await post("/problems/cross-cloud/deploy", VALID_AWS);
    const body = await res.json();

    expect(body).toEqual({
      jobId: PARENT_ID,
      status: "PENDING",
      namePrefix: "tc-cross-cloud-alpha",
      teamLoginKey: "KEY1",
      expiresAt: 1_700_000_028_800,
    });
  });

  it("should return parent response when one target dispatch fails", async () => {
    spies.dispatch.mockResolvedValue({
      parentDeploymentId: PARENT_ID,
      targets: [
        { targetId: "aws-api", targetDeploymentId: "td-0", outcome: "started" as const },
        { targetId: "gcp-worker", targetDeploymentId: "td-1", outcome: "started" as const },
        {
          targetId: "azure-edge",
          targetDeploymentId: "td-2",
          outcome: "dispatch_failed" as const,
        },
        { targetId: "sakura-svc", targetDeploymentId: "td-3", outcome: "started" as const },
      ],
    });

    const res = await post("/problems/cross-cloud/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    const body = await res.json();
    expect(body.jobId).toBe(PARENT_ID);
    expect(body.status).toBe("PENDING");
  });

  it("should not dispatch when materialization fails", async () => {
    spies.materialize.mockRejectedValueOnce(new Error("createTarget failed"));

    const res = await post("/problems/cross-cloud/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it("should not require AWS input for Azure and Sakura only composite", async () => {
    spies.dispatch.mockResolvedValue(dispatchResult(["azure-edge", "sakura-svc"]));

    const res = await post("/problems/no-aws-composite/deploy", { teamName: "Alpha" });

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(spies.materialize).toHaveBeenCalledOnce();
    expect(spies.dispatch).toHaveBeenCalledOnce();
  });

  it("should require AWS input when a composite includes AWS target", async () => {
    const res = await post("/problems/cross-cloud/deploy", { teamName: "Alpha" });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("aws_input_required");
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it("should enforce deploy quota once per composite parent request", async () => {
    spies.dispatch.mockResolvedValue(
      dispatchResult(["aws-api", "gcp-worker", "azure-edge", "sakura-svc"]),
    );

    await post("/problems/cross-cloud/deploy", VALID_AWS);

    // Once for the four-target parent, not once per target.
    expect(spies.enforceQuota).toHaveBeenCalledOnce();
    expect(spies.enforceQuota).toHaveBeenCalledWith("tenant-acme", "basic");
  });

  it("should return 429 with quota info when the composite parent hits the quota", async () => {
    const { DeployQuotaExceededError } = await import(
      "../../lib/problem-deploy/handlers/deploy-handler/deploy-quota"
    );
    spies.enforceQuota.mockRejectedValueOnce(new DeployQuotaExceededError("basic", 2, 2));

    const res = await post("/problems/cross-cloud/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.TOO_MANY_REQUESTS);
    const body = await res.json();
    expect(body).toMatchObject({ error: "deploy_quota_exceeded", tier: "basic", limit: 2 });
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it("should 400 validation_failed on a malformed composite body", async () => {
    // A wrong-typed field fails CompositeDeployRequestSchema before any dispatch —
    // the composite path returns the same validation_failed shape as the legacy path.
    const res = await post("/problems/cross-cloud/deploy", { region: 123 });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });
});

describe("POST /problems/:problemId/deploy — legacy path unchanged (#2075)", () => {
  it("should keep omitted runtime on legacy startDeployment path", async () => {
    spies.startDeployment.mockResolvedValue({
      jobId: "JOB1",
      status: "PENDING",
      namePrefix: "tc-legacy-alpha",
      teamLoginKey: "K",
      expiresAt: 1,
    });

    const res = await post("/problems/legacy-no-runtime/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(spies.startDeployment).toHaveBeenCalledOnce();
    // composite collaborators are never touched on the legacy path.
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
    // route still passes the JWT-derived quota tier through to startDeployment.
    expect(spies.startDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ problemId: "legacy-no-runtime", quotaTier: "basic" }),
    );
  });

  it("should keep explicit single AWS runtime on legacy startDeployment path", async () => {
    spies.startDeployment.mockResolvedValue({
      jobId: "JOB2",
      status: "PENDING",
      namePrefix: "tc-explicit-aws-alpha",
      teamLoginKey: "K",
      expiresAt: 1,
    });

    // `explicit-aws` is omitted from BATTLE_PROBLEMS_RUNTIMES (AWS is the
    // default), so the descriptor resolver returns undefined → legacy path.
    const res = await post("/problems/explicit-aws/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(spies.startDeployment).toHaveBeenCalledOnce();
    expect(spies.materialize).not.toHaveBeenCalled();
  });

  it("should keep explicit GCP Azure and Sakura single runtime paths unchanged", async () => {
    spies.startDeployment.mockResolvedValue({
      jobId: "JOB3",
      status: "PENDING",
      namePrefix: "tc-gcp-only-alpha",
      teamLoginKey: "K",
      expiresAt: 1,
    });

    // `gcp-only` is a single (non-composite) descriptor → legacy startDeployment
    // path (which enforces the runtime gate inside, untouched by #2075).
    const res = await post("/problems/gcp-only/deploy", VALID_AWS);

    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(spies.startDeployment).toHaveBeenCalledOnce();
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });

  it("should still require AWS input on the legacy single-provider request schema", async () => {
    // The legacy schema keeps awsAccountId/region REQUIRED — a missing field is a
    // 400 validation_failed, byte-identical to the pre-#2075 contract.
    const res = await post("/problems/legacy-no-runtime/deploy", { teamName: "Alpha" });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(spies.startDeployment).not.toHaveBeenCalled();
  });
});

/**
 * [Issue #3002] composite deploy の `Idempotency-Key`。
 *
 * composite は route の別分岐を通るので、 単一 provider 側だけ記録していると **composite
 * だけ再送で二重に走る**。 分岐ごとに固定する。
 */
describe("composite deploy with Idempotency-Key (Issue 3002)", () => {
  const KEY = "99999999-8888-4777-8666-555555555555";

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

  const postWithKey = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify(body),
    });

  it("は composite の再送で materialize / dispatch を再実行しない", async () => {
    const repository = await inMemoryIdempotency();
    spies.resolveIdempotencyRepository.mockResolvedValue(repository);

    const first = await postWithKey("/problems/cross-cloud/deploy", {
      teamName: "Alpha",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
    });
    const firstBody = await first.json();
    spies.materialize.mockClear();
    spies.dispatch.mockClear();

    const replay = await postWithKey("/problems/cross-cloud/deploy", {
      teamName: "Alpha",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
    });
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(firstBody);
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.dispatch).not.toHaveBeenCalled();
  });
});
