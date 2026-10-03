/**
 * [Issue #2747] Tests for `dispatchCompositeReadyTargets` — the maintenance-tick entry point that
 * re-drives `dispatchCompositeDeployment` for every active Composite parent so later DAG waves
 * progress once upstream targets complete.
 *
 * `dispatchCompositeDeployment` and its connection/adapter dependencies are mocked at the module
 * boundary (they have their own dedicated test suites); this file exercises the real wiring closures
 * `dispatchCompositeReadyTargets` builds — `resolveConnection`, `selectAdapter`, and `now` — plus its
 * per-parent failure isolation (a thrown Error or non-Error value never stops the batch).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProblemRuntime } from "../../lib/problem-deploy/handlers/shared/runtime/adapter";

const mocks = vi.hoisted(() => ({
  dispatchCompositeDeployment: vi.fn(),
  resolveCompositeTargetConnection: vi.fn(),
  buildAdapterDependencies: vi.fn(),
  selectAdapter: vi.fn(),
}));

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch", () => ({
  dispatchCompositeDeployment: mocks.dispatchCompositeDeployment,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/composite-target-connection", () => ({
  resolveCompositeTargetConnection: mocks.resolveCompositeTargetConnection,
}));
vi.mock("../../lib/problem-deploy/handlers/deploy-handler/adapter-dependencies", () => ({
  buildAdapterDependencies: mocks.buildAdapterDependencies,
}));
vi.mock("../../lib/problem-deploy/handlers/shared/runtime/index", () => ({
  selectAdapter: mocks.selectAdapter,
}));

// Imported after the mocks so the module under test picks up the mocked dependencies above.
const { dispatchCompositeReadyTargets } = await import(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-ready-dispatch"
);
type GenericScoringSharedResources =
  import("../../lib/problem-deploy/handlers/generic-scoring-handler/shared").GenericScoringSharedResources;
type CompositeDispatchDeps =
  import("../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch").CompositeDispatchDeps;

const NOW_MS = Date.parse("2026-07-22T00:00:00.000Z");

function makeShared(
  forEachCompositeDeployReconcilablePage: ReturnType<typeof vi.fn>,
): GenericScoringSharedResources {
  return {
    runtime: {
      resolveDeploymentsRepository: vi.fn(async () => ({
        forEachCompositeDeployReconcilablePage,
      })),
    },
    ddb: {} as GenericScoringSharedResources["ddb"],
    deploymentsTableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "TestEndpoints",
    competitorAccountsTableName: "TestCompetitorAccounts",
    problemsScoring: {},
    problemsEndpoints: {},
    problemsDisruptions: {},
    problemsCatalog: { "cross-cloud": "problems/cross-cloud" },
    disruptionsTableName: "TestDisruptions",
    eventBusName: "test-bus",
    events: {} as GenericScoringSharedResources["events"],
    env: "test",
    ssm: {} as GenericScoringSharedResources["ssm"],
    sakuraAppRunBaseUrl: undefined,
  } as unknown as GenericScoringSharedResources;
}

describe("dispatchCompositeReadyTargets (#2747)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should dispatch every active Composite parent returned by the reconcilable-page scan", async () => {
    mocks.dispatchCompositeDeployment.mockResolvedValue(undefined);
    const forEachCompositeDeployReconcilablePage = vi.fn(async (onPage) => {
      await onPage([{ jobId: "parent-1" }, { jobId: "parent-2" }]);
    });
    const shared = makeShared(forEachCompositeDeployReconcilablePage);

    await dispatchCompositeReadyTargets(shared, NOW_MS);

    expect(mocks.dispatchCompositeDeployment).toHaveBeenCalledTimes(2);
    const [deps1, parentId1] = mocks.dispatchCompositeDeployment.mock.calls[0] as [
      CompositeDispatchDeps,
      string,
    ];
    expect(parentId1).toBe("parent-1");
    expect(deps1.now()).toBe(NOW_MS);
    expect(deps1.problemsCatalog).toEqual({ "cross-cloud": "problems/cross-cloud" });
  });

  it("should build the resolveConnection closure by delegating to resolveCompositeTargetConnection", async () => {
    mocks.dispatchCompositeDeployment.mockResolvedValue(undefined);
    mocks.resolveCompositeTargetConnection.mockResolvedValue({
      provider: "gcp",
      teamSlug: "alpha",
    });
    const forEachCompositeDeployReconcilablePage = vi.fn(async (onPage) => {
      await onPage([{ jobId: "parent-1" }]);
    });
    const shared = makeShared(forEachCompositeDeployReconcilablePage);

    await dispatchCompositeReadyTargets(shared, NOW_MS);

    const [deps] = mocks.dispatchCompositeDeployment.mock.calls[0] as [CompositeDispatchDeps];
    const connectionInput = {
      provider: "gcp" as const,
      tenantId: "tenant-a",
      teamSlug: "alpha",
    };
    const connection = await deps.resolveConnection(connectionInput);

    expect(connection).toEqual({ provider: "gcp", teamSlug: "alpha" });
    expect(mocks.resolveCompositeTargetConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        aws: expect.objectContaining({
          competitorAccountsTableName: "TestCompetitorAccounts",
        }),
        credentials: expect.objectContaining({ env: "test" }),
      }),
      connectionInput,
    );
  });

  it("should build the selectAdapter closure by delegating to buildAdapterDependencies + selectAdapter", async () => {
    mocks.dispatchCompositeDeployment.mockResolvedValue(undefined);
    const fakeAdapter = { deploy: vi.fn() };
    mocks.buildAdapterDependencies.mockReturnValue({ aws: { events: {}, eventBusName: "bus" } });
    mocks.selectAdapter.mockReturnValue(fakeAdapter);
    const forEachCompositeDeployReconcilablePage = vi.fn(async (onPage) => {
      await onPage([{ jobId: "parent-1" }]);
    });
    const shared = makeShared(forEachCompositeDeployReconcilablePage);

    await dispatchCompositeReadyTargets(shared, NOW_MS);

    const [deps] = mocks.dispatchCompositeDeployment.mock.calls[0] as [CompositeDispatchDeps];
    const runtime: ProblemRuntime = {
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    };
    const target = {
      tenantId: "tenant-a",
      teamName: "Team Alpha",
    } as Parameters<CompositeDispatchDeps["selectAdapter"]>[1];

    const adapter = deps.selectAdapter(runtime, target);

    expect(adapter).toBe(fakeAdapter);
    expect(mocks.buildAdapterDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ env: "test", tenantId: "tenant-a" }),
      runtime,
      "team-alpha",
    );
    expect(mocks.selectAdapter).toHaveBeenCalledWith(runtime, {
      aws: { events: {}, eventBusName: "bus" },
    });
  });

  it("should log and continue when one parent's dispatch throws an Error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dispatchCompositeDeployment
      .mockRejectedValueOnce(new Error("dispatch exploded"))
      .mockResolvedValueOnce(undefined);
    const forEachCompositeDeployReconcilablePage = vi.fn(async (onPage) => {
      await onPage([{ jobId: "parent-failing" }, { jobId: "parent-ok" }]);
    });
    const shared = makeShared(forEachCompositeDeployReconcilablePage);

    await expect(dispatchCompositeReadyTargets(shared, NOW_MS)).resolves.toBeUndefined();

    expect(mocks.dispatchCompositeDeployment).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[composite-dataflow] ready-target dispatch failed",
      expect.objectContaining({ parentDeploymentId: "parent-failing", message: "Error" }),
    );
    warn.mockRestore();
  });

  it("should log a generic reason when a non-Error value is thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dispatchCompositeDeployment.mockRejectedValueOnce("not an Error instance");
    const forEachCompositeDeployReconcilablePage = vi.fn(async (onPage) => {
      await onPage([{ jobId: "parent-1" }]);
    });
    const shared = makeShared(forEachCompositeDeployReconcilablePage);

    await dispatchCompositeReadyTargets(shared, NOW_MS);

    expect(warn).toHaveBeenCalledWith(
      "[composite-dataflow] ready-target dispatch failed",
      expect.objectContaining({ parentDeploymentId: "parent-1", message: "unknown error" }),
    );
    warn.mockRestore();
  });
});
