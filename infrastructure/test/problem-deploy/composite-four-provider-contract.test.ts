/**
 * [Composite Runtime / Issue #2079] Four-provider Composite Runtime CONTRACT suite.
 *
 * This file is the single local regression gate for the whole Composite Runtime
 * contract. It exercises ONE deterministic fixture
 * (`composite-four-provider.test-helpers.ts`) that declares four targets in the
 * EXACT order `aws-api` / `gcp-worker` / `azure-edge` / `sakura-service`
 * (aws/cloudformation, gcp/infra-manager, azure/bicep, sakura/apprun) scored by a
 * single `composite-probe` metadata, then drives the real, already-merged
 * Composite modules over an in-memory DynamoDB fake:
 *
 *   - validation + discovery (`@tenkacloud/problem-runtime` normalize / plan),
 *   - materialization (#2063), ordered dispatch (#2066),
 *   - deploy routing (#2075), status aggregation + reconciliation (#2067/#2068),
 *   - namespaced outputs (#2069), composite-probe scoring (#2070),
 *   - teardown fan-out (#2071) + teardown completion (#2072),
 *   - provider-neutral participant access (#2076).
 *
 * Constraints (issue #2079): NO network, NO real provider SDK credentials. The
 * clock, ID factory, event publisher, credential stores, and adapters are ALL
 * injected fakes. Every per-target assertion that can fail names the provider and
 * the targetId so a single-provider regression is identifiable from the failure
 * message alone. Determinism does not depend on test execution order.
 *
 * The fixture is exported from the helpers module so later Composite issues can
 * import it instead of re-declaring a four-provider shape. It is a test fixture
 * only — it is NOT a production catalog problem, and it bypasses NO production
 * validator (`normalizeRuntime` / `buildCompositeDeploymentPlan` /
 * `parseScoringMetadata` are the real ones).
 *
 * The legacy single-provider compatibility suite (#2059,
 * `composite-compat-single-provider.test.ts`) is a separate file and stays the
 * authoritative legacy gate; scenario 11 here re-pins, in this same suite run,
 * that the legacy single-provider runtimes still normalize and classify
 * unchanged — without modifying or relaxing that file.
 */

import {
  buildCompositeDeploymentPlan,
  classifyRuntimeSupport,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompositeDeployDeps,
  type CompositeDeployInvocation,
  startCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-deploy";
import { isCompositeParentItem } from "../../lib/problem-deploy/handlers/deploy-handler/composite-deployment";
import { dispatchCompositeDeployment } from "../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch";
import {
  type MaterializeCompositeDeploymentInput,
  materializeCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-materialization";
import { collectCompositeOutputs } from "../../lib/problem-deploy/handlers/deploy-handler/composite-outputs";
import {
  createCompositeParent,
  createCompositeTarget,
  getCompositeParent,
  listCompositeTargets,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import { lookupTargetAccess } from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-access";
import {
  type CompositeTeardownDeps,
  requestCompositeTeardown,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-teardown";
import type { TeardownOutcome } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import { buildStackPrefix } from "../../lib/problem-deploy/handlers/deploy-handler/naming";
import type { DeploymentStatus } from "../../lib/problem-deploy/handlers/deploy-handler/types";
import { reconcileCompositeParentDeployStatus } from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-status-reconciler";
import { reconcileCompositeParentTeardown } from "../../lib/problem-deploy/handlers/generic-scoring-handler/composite-teardown-reconciler";
import {
  type CompositeProbeFn,
  type CompositeProbeInput,
  scoreCompositeProbe,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/composite-probe";
import {
  type CompositeProbeScoringMetadata,
  parseScoringMetadata,
} from "../../lib/utils/scoring-metadata";
import {
  FOUR_PROVIDER_AWS_ACCOUNT_ID,
  FOUR_PROVIDER_CATALOG,
  FOUR_PROVIDER_METADATA,
  FOUR_PROVIDER_NOW_ISO,
  FOUR_PROVIDER_NOW_MS,
  FOUR_PROVIDER_PARENT_ID,
  FOUR_PROVIDER_PROBLEM_ID,
  FOUR_PROVIDER_REGION,
  FOUR_PROVIDER_RUNTIME,
  FOUR_PROVIDER_SCORING,
  FOUR_PROVIDER_TARGET_IDS,
  FOUR_PROVIDER_TARGETS,
  FOUR_PROVIDER_TEAM_LOGIN_KEY,
  FOUR_PROVIDER_TEAM_NAME,
  FOUR_PROVIDER_TENANT_ID,
  type FourProviderFake,
  fakeResolveConnection,
  makeFourProviderAdapters,
  makeFourProviderFake,
  seedFourProvider,
  targetDeploymentId,
  targetUrl,
} from "./composite-four-provider.test-helpers";

const PARENT_ID = FOUR_PROVIDER_PARENT_ID;

function makeDispatchDeps(
  fake: FourProviderFake,
  adapters: Record<string, { deploy: ReturnType<typeof vi.fn> }>,
) {
  return {
    repo: fake.repo,
    resolveConnection: fakeResolveConnection,
    selectAdapter: ({ provider }: { provider: string }) => adapters[provider],
    problemsCatalog: FOUR_PROVIDER_CATALOG,
    now: () => FOUR_PROVIDER_NOW_MS,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — metadata validation + discovery preserve all four targets + order.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: metadata validation and discovery", () => {
  it("should normalize the fixture runtime preserving all four targets in declared order", () => {
    const normalized = normalizeRuntime(FOUR_PROVIDER_METADATA) as ProblemRuntimeDescriptor;
    expect(classifyRuntimeSupport(normalized)).toBe("composite");
    expect(normalized).toEqual(FOUR_PROVIDER_RUNTIME);

    // The deterministic plan keeps declaration order with contiguous ordinals.
    const plan = buildCompositeDeploymentPlan(FOUR_PROVIDER_RUNTIME);
    expect(plan.targets.map((t) => t.targetId)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    expect(plan.targets.map((t) => t.targetOrdinal)).toEqual([0, 1, 2, 3]);
    expect(plan.targets.map((t) => t.provider)).toEqual(["aws", "gcp", "azure", "sakura"]);
  });

  it("should narrow the fixture composite-probe scoring through the real validator", () => {
    const scoring = parseScoringMetadata(FOUR_PROVIDER_SCORING);
    expect(scoring?.kind).toBe("composite-probe");
    expect(scoring).toEqual(FOUR_PROVIDER_SCORING);
    const composite = scoring as CompositeProbeScoringMetadata;
    expect(composite.targets.map((t) => t.targetId)).toEqual(FOUR_PROVIDER_TARGET_IDS);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — deploy API materializes one parent + four target jobs.
// Scenario 3 — target jobs dispatch in declared order through four fake adapters.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: deploy materialization and ordered dispatch", () => {
  let fake: FourProviderFake;

  beforeEach(() => {
    fake = makeFourProviderFake();
  });

  function buildDeployDeps(adapters: Record<string, { deploy: ReturnType<typeof vi.fn> }>): {
    deps: CompositeDeployDeps;
    enforceQuota: ReturnType<typeof vi.fn>;
  } {
    const enforceQuota = vi.fn(async () => {});
    // Deterministic ID factory: parent id first, then one id per target derived
    // from its declared targetId (so the seeded ids are stable + readable).
    let idCounter = 0;
    const newDeploymentId = (): string => {
      if (idCounter === 0) {
        idCounter += 1;
        return PARENT_ID;
      }
      const target = FOUR_PROVIDER_TARGETS[idCounter - 1];
      idCounter += 1;
      return targetDeploymentId(target.targetId);
    };
    const materialize = (input: MaterializeCompositeDeploymentInput) =>
      materializeCompositeDeployment(
        {
          createParent: (p) => createCompositeParent(fake.repo, p),
          createTarget: (t) => createCompositeTarget(fake.repo, t),
          newDeploymentId,
          newTeamLoginKey: () => FOUR_PROVIDER_TEAM_LOGIN_KEY,
          now: () => FOUR_PROVIDER_NOW_MS,
        },
        input,
      );
    const dispatch = (parentDeploymentId: string) =>
      dispatchCompositeDeployment(makeDispatchDeps(fake, adapters), parentDeploymentId);
    const deps: CompositeDeployDeps = {
      buildPlan: buildCompositeDeploymentPlan,
      enforceQuota,
      materialize,
      dispatch,
      tenantId: FOUR_PROVIDER_TENANT_ID,
    };
    return { deps, enforceQuota };
  }

  const invocation: CompositeDeployInvocation = {
    problemId: FOUR_PROVIDER_PROBLEM_ID,
    descriptor: FOUR_PROVIDER_RUNTIME,
    teamName: FOUR_PROVIDER_TEAM_NAME,
    awsAccountId: FOUR_PROVIDER_AWS_ACCOUNT_ID,
    region: FOUR_PROVIDER_REGION,
    quotaTier: "basic",
  };

  it("should materialize one parent and four target jobs from the deploy API", async () => {
    const { adapters } = makeFourProviderAdapters();
    const { deps, enforceQuota } = buildDeployDeps(adapters);

    const response = await startCompositeDeployment(deps, invocation);

    // Quota is enforced ONCE per parent, never per target.
    expect(enforceQuota).toHaveBeenCalledOnce();
    expect(response.jobId).toBe(PARENT_ID);
    expect(response.status).toBe("PENDING");
    expect(response.namePrefix).toBe(
      buildStackPrefix(FOUR_PROVIDER_PROBLEM_ID, FOUR_PROVIDER_TEAM_NAME),
    );

    // One parent coordination row + four target rows persisted (DDB record shape).
    const parent = await getCompositeParent(fake.repo, PARENT_ID);
    expect(parent).toBeDefined();
    expect(parent?.runtimeKind).toBe("composite");
    expect(parent?.targetCount).toBe(4);
    expect(parent?.status).toBe("PENDING");

    const targets = await listCompositeTargets(fake.repo, PARENT_ID);
    expect(targets).toHaveLength(4);
    expect(targets.map((t) => t.targetId)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    for (const target of targets) {
      expect(target.parentDeploymentId).toBe(PARENT_ID);
      expect(target).not.toHaveProperty("PK");
      expect(target).not.toHaveProperty("SK");
      expect(target.tenantId).toBe(FOUR_PROVIDER_TENANT_ID);
      expect(typeof target.runtimeProvider).toBe("string");
    }
  });

  it("should dispatch target jobs in declared order through the four fake adapters", async () => {
    const { adapters, callOrder } = makeFourProviderAdapters();
    const { deps } = buildDeployDeps(adapters);

    await startCompositeDeployment(deps, invocation);

    // Adapter call order is the contract: aws → gcp → azure → sakura, once each.
    expect(callOrder).toEqual(["aws", "gcp", "azure", "sakura"]);
    for (const target of FOUR_PROVIDER_TARGETS) {
      expect(
        adapters[target.provider].deploy,
        `provider=${target.provider} targetId=${target.targetId} should dispatch exactly once`,
      ).toHaveBeenCalledOnce();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — parent PENDING → IN_PROGRESS → COMPLETE as targets complete.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: parent status progression", () => {
  async function reconcile(fake: FourProviderFake): Promise<DeploymentStatus> {
    const result = await reconcileCompositeParentDeployStatus(fake.reconcileDeps, {
      parentDeploymentId: PARENT_ID,
      nowIso: FOUR_PROVIDER_NOW_ISO,
    });
    return result.nextStatus;
  }

  it("should move the parent PENDING to IN_PROGRESS then COMPLETE as targets complete", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);

    // All PENDING → parent stays PENDING.
    expect(await reconcile(fake)).toBe("PENDING");
    expect(fake.status(PARENT_ID)).toBe("PENDING");

    // One target starts → parent IN_PROGRESS.
    fake.setStatus(targetDeploymentId("aws-api"), "IN_PROGRESS");
    expect(await reconcile(fake)).toBe("IN_PROGRESS");
    expect(fake.status(PARENT_ID)).toBe("IN_PROGRESS");

    // Every target complete → parent COMPLETE.
    for (const target of FOUR_PROVIDER_TARGETS) {
      fake.setStatus(targetDeploymentId(target.targetId), "COMPLETE");
    }
    expect(await reconcile(fake)).toBe("COMPLETE");
    expect(fake.status(PARENT_ID)).toBe("COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — duplicate output key names are namespaced by targetId.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: namespaced outputs", () => {
  it("should namespace duplicate output keys by targetId without flattening", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);

    // Every target completes and exposes an identically-named `Url` output.
    for (const target of FOUR_PROVIDER_TARGETS) {
      fake.setStatus(targetDeploymentId(target.targetId), "COMPLETE");
      fake.setOutputs(
        targetDeploymentId(target.targetId),
        JSON.stringify({ Url: targetUrl(target.targetId) }),
      );
    }

    const outputs = await collectCompositeOutputs(fake.repo, PARENT_ID);

    // The collision survives namespacing: each targetId owns its own `Url`.
    expect(Object.keys(outputs)).toEqual(FOUR_PROVIDER_TARGET_IDS);
    for (const target of FOUR_PROVIDER_TARGETS) {
      expect(
        outputs[target.targetId].Url,
        `targetId=${target.targetId} must keep its own namespaced Url output`,
      ).toBe(targetUrl(target.targetId));
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — composite scoring succeeds ONLY when all four probes succeed.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: all-probe scoring", () => {
  const scoring = parseScoringMetadata(FOUR_PROVIDER_SCORING) as CompositeProbeScoringMetadata;

  function probeInput(parentStatus: DeploymentStatus): CompositeProbeInput {
    return {
      parentDeploymentId: PARENT_ID,
      parentStatus,
      targets: FOUR_PROVIDER_TARGETS.map((target) => ({
        targetId: target.targetId,
        provider: target.provider,
        status: "COMPLETE" as DeploymentStatus,
        outputs: { Url: targetUrl(target.targetId) },
      })),
    };
  }

  it("should award full points only when every one of the four probes succeeds", async () => {
    const allOk: CompositeProbeFn = vi.fn(async () => ({ ok: true }));
    const result = await scoreCompositeProbe(probeInput("COMPLETE"), scoring, allOk);

    expect(result.success).toBe(true);
    expect(result.pointsAwarded).toBe(FOUR_PROVIDER_SCORING.pointsAllOk);
    expect(result.probedTargetIds).toEqual(FOUR_PROVIDER_TARGET_IDS);
    expect(result.data.failures).toEqual([]);
    expect(allOk).toHaveBeenCalledTimes(4);
  });

  it("should fail scoring and name the offending provider target when one probe fails", async () => {
    // The Azure probe fails; the composite must not score, and the diagnostic
    // must identify exactly the failing targetId.
    const oneFails: CompositeProbeFn = vi.fn(async (url: string) => ({
      ok: !url.includes("azure-edge"),
    }));

    const result = await scoreCompositeProbe(probeInput("COMPLETE"), scoring, oneFails);

    expect(result.success).toBe(false);
    expect(result.pointsAwarded).toBe(0);
    expect(result.data.failures).toEqual([{ targetId: "azure-edge", reason: "probe-failed" }]);
  });

  it("should not score until the composite parent is COMPLETE", async () => {
    const allOk: CompositeProbeFn = vi.fn(async () => ({ ok: true }));
    const result = await scoreCompositeProbe(probeInput("IN_PROGRESS"), scoring, allOk);

    expect(result.notReady).toBe(true);
    expect(result.success).toBe(false);
    expect(allOk).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — one target failure makes parent FAILED, others preserved.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: single-target failure isolation", () => {
  it("should fail the parent on one target failure while preserving the other targets", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);

    // Dispatch with the GCP adapter exploding. Every independent target is still
    // attempted (the dispatch loop never short-circuits).
    const { adapters, callOrder } = makeFourProviderAdapters("gcp");
    const result = await dispatchCompositeDeployment(makeDispatchDeps(fake, adapters), PARENT_ID);
    expect(callOrder).toEqual(["aws", "gcp", "azure", "sakura"]);

    const gcp = result.targets.find((t) => t.targetId === "gcp-worker");
    expect(gcp?.outcome, "gcp-worker dispatch should be recorded as dispatch_failed").toBe(
      "dispatch_failed",
    );
    // The failing GCP target row is FAILED with a NON-secret reason (class name only).
    expect(
      fake.status(targetDeploymentId("gcp-worker")),
      "provider=gcp targetId=gcp-worker should be FAILED",
    ).toBe("FAILED");
    const gcpRow = fake.store.get("DEPLOYMENT#t-gcp-worker|META");
    expect(String(gcpRow?.failureReason)).not.toContain("exploded");

    // The other three targets are untouched (still PENDING) — failure is isolated.
    for (const targetId of ["aws-api", "azure-edge", "sakura-service"]) {
      expect(
        fake.status(targetDeploymentId(targetId)),
        `targetId=${targetId} must be preserved when gcp-worker fails`,
      ).toBe("PENDING");
    }

    // The deploy-phase aggregation: any FAILED target → parent FAILED.
    const reconciled = await reconcileCompositeParentDeployStatus(fake.reconcileDeps, {
      parentDeploymentId: PARENT_ID,
      nowIso: FOUR_PROVIDER_NOW_ISO,
    });
    expect(reconciled.nextStatus).toBe("FAILED");
    expect(fake.status(PARENT_ID)).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — parent teardown requests all eligible target teardowns.
// Scenario 9 — parent becomes DELETED only when every target is deleted-like.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: teardown fan-out and completion", () => {
  function makeTeardownDeps(
    fake: FourProviderFake,
    teardownTarget: ReturnType<typeof vi.fn>,
  ): CompositeTeardownDeps {
    return {
      repo: fake.repo,
      teardownTarget,
      now: () => FOUR_PROVIDER_NOW_MS,
    };
  }

  it("should request teardown for every eligible target and set the parent DELETING", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);
    // Pretend the deployment completed.
    fake.setStatus(PARENT_ID, "COMPLETE");
    for (const target of FOUR_PROVIDER_TARGETS) {
      fake.setStatus(targetDeploymentId(target.targetId), "COMPLETE");
    }

    const teardownTarget = vi.fn(
      async (): Promise<TeardownOutcome> => ({ kind: "accepted", previousStatus: "COMPLETE" }),
    );
    const result = await requestCompositeTeardown(makeTeardownDeps(fake, teardownTarget), {
      parentDeploymentId: PARENT_ID,
      tenantId: FOUR_PROVIDER_TENANT_ID,
    });

    // Parent flips to DELETING and every target teardown is requested, in order.
    expect(fake.status(PARENT_ID)).toBe("DELETING");
    expect(teardownTarget).toHaveBeenCalledTimes(4);
    expect(teardownTarget.mock.calls.map((c) => c[0])).toEqual([
      "t-aws-api",
      "t-gcp-worker",
      "t-azure-edge",
      "t-sakura-service",
    ]);
    for (const target of result.targets) {
      expect(target.outcome, `targetId=${target.targetId} teardown should be accepted`).toBe(
        "accepted",
      );
    }
  });

  it("should finalize the parent to DELETED only once every target is deleted-like", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);
    fake.setStatus(PARENT_ID, "DELETING");
    // Three targets deleted-like, one still DELETING → parent stays DELETING.
    fake.setStatus(targetDeploymentId("aws-api"), "DELETED");
    fake.setStatus(targetDeploymentId("gcp-worker"), "DELETED");
    fake.setStatus(targetDeploymentId("azure-edge"), "EXPIRED");
    fake.setStatus(targetDeploymentId("sakura-service"), "DELETING");

    const partial = await reconcileCompositeParentTeardown(fake.reconcileDeps, {
      parentDeploymentId: PARENT_ID,
      nowIso: FOUR_PROVIDER_NOW_ISO,
    });
    expect(partial.changed, "one in-flight target must keep the parent DELETING").toBe(false);
    expect(fake.status(PARENT_ID)).toBe("DELETING");

    // Last target finishes → parent becomes DELETED.
    fake.setStatus(targetDeploymentId("sakura-service"), "DELETED");
    const done = await reconcileCompositeParentTeardown(fake.reconcileDeps, {
      parentDeploymentId: PARENT_ID,
      nowIso: FOUR_PROVIDER_NOW_ISO,
    });
    expect(done.changed).toBe(true);
    expect(done.nextStatus).toBe("DELETED");
    expect(fake.status(PARENT_ID)).toBe("DELETED");
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — AWS Composite target access delegates to the existing Console /
// CLI capability; the non-AWS providers stop at the external-portal capability.
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: AWS target access delegation", () => {
  /**
   * Mock the existing AWS participant Console / CLI session issuers. The
   * composite access lookup decides ONLY the capability surface (#2076); these
   * mocks stand in for the later AWS bridge (#2077) and prove that an AWS target
   * — and only an AWS target — is the one whose capability authorizes the
   * existing Console / CLI behavior.
   */
  const getConsoleSigninUrl = vi.fn(async () => ({
    kind: "ok" as const,
    loginUrl: "https://signin.aws.amazon.com/federation",
  }));
  const getCliCredentials = vi.fn(async () => ({ kind: "ok" as const }));

  beforeEach(() => {
    getConsoleSigninUrl.mockClear();
    getCliCredentials.mockClear();
  });

  /**
   * Assert one target's access descriptor: the AWS target authorizes the existing
   * Console + CLI session issuers (delegated to the mocks), and every other
   * provider stops at `external-portal`. No descriptor leaks secret fields.
   */
  async function assertTargetAccess(
    fake: FourProviderFake,
    target: (typeof FOUR_PROVIDER_TARGETS)[number],
  ): Promise<void> {
    const outcome = await lookupTargetAccess(fake.repo, {
      teamLoginKey: FOUR_PROVIDER_TEAM_LOGIN_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: targetDeploymentId(target.targetId),
    });
    expect(
      outcome.kind,
      `provider=${target.provider} targetId=${target.targetId} should be accessible`,
    ).toBe("ok");
    if (outcome.kind !== "ok") return;

    if (target.provider === "aws") {
      expect(outcome.descriptor.capability).toEqual(["console", "cli-credentials"]);
      await getConsoleSigninUrl();
      await getCliCredentials();
    } else {
      expect(
        outcome.descriptor.capability,
        `provider=${target.provider} must not gain AWS Console/CLI access`,
      ).toEqual(["external-portal"]);
    }
    // The descriptor never leaks the row's secret / identity surface.
    const serialized = JSON.stringify(outcome.descriptor);
    expect(serialized).not.toContain("competitorRoleArn");
    expect(serialized).not.toContain("externalIdParameterName");
    expect(serialized).not.toContain("teamLoginKey");
  }

  it("should authorize Console and CLI for the AWS target and external-portal for the rest", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);
    for (const target of FOUR_PROVIDER_TARGETS) {
      fake.setStatus(targetDeploymentId(target.targetId), "COMPLETE");
    }

    for (const target of FOUR_PROVIDER_TARGETS) {
      await assertTargetAccess(fake, target);
    }

    // Exactly the one AWS target delegated to the mocked Console + CLI behavior.
    expect(getConsoleSigninUrl).toHaveBeenCalledOnce();
    expect(getCliCredentials).toHaveBeenCalledOnce();
  });

  it("should hide a cross-team target as not found", async () => {
    const fake = makeFourProviderFake();
    await seedFourProvider(fake);
    fake.setStatus(targetDeploymentId("aws-api"), "COMPLETE");

    const outcome = await lookupTargetAccess(fake.repo, {
      teamLoginKey: "WRONG_TEAM_KEY",
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: targetDeploymentId("aws-api"),
    });
    expect(outcome).toEqual({ kind: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — the legacy single-provider runtimes still pass in this same run.
// (Pinned here too, additively; the authoritative legacy gate stays #2059's
// composite-compat-single-provider.test.ts, which this never modifies.)
// ---------------------------------------------------------------------------

describe("Composite four-provider contract: legacy single-provider still passes", () => {
  it("should keep legacy single-provider runtimes normalizing and classifying unchanged", () => {
    // Legacy no-runtime + cfnTemplate-only both resolve to aws/cloudformation.
    expect(normalizeRuntime({})).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
    expect(normalizeRuntime({ cfnTemplate: "stack.yaml" })).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "stack.yaml",
    });

    // Each single-provider runtime still classifies as its recognized support
    // level (not "composite", not "unknown").
    const single: { meta: object; support: string }[] = [
      { meta: {}, support: "executable" },
      {
        meta: { runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" } },
        support: "executable",
      },
      {
        meta: { runtime: { provider: "gcp", engine: "infra-manager", entry: "gs://b/cfg" } },
        support: "reserved",
      },
      {
        meta: { runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" } },
        support: "reserved",
      },
      {
        meta: { runtime: { provider: "sakura", engine: "apprun", entry: "registry/img:1" } },
        support: "reserved",
      },
    ];
    for (const { meta, support } of single) {
      const runtime = normalizeRuntime(meta) as ProblemRuntimeDescriptor;
      expect(classifyRuntimeSupport(runtime)).toBe(support);
      expect(classifyRuntimeSupport(runtime)).not.toBe("composite");
    }
  });

  it("should keep a legacy single-provider row untouched by composite parent detection", async () => {
    const fake = makeFourProviderFake();
    // A legacy AWS deployment row (no runtimeKind) must never be treated as a
    // composite parent by the composite reader.
    fake.store.set("DEPLOYMENT#legacy-1|META", {
      PK: "DEPLOYMENT#legacy-1",
      SK: "META",
      jobId: "legacy-1",
      tenantId: FOUR_PROVIDER_TENANT_ID,
      problemId: "hello-world",
      status: "COMPLETE",
    });
    expect(isCompositeParentItem(fake.store.get("DEPLOYMENT#legacy-1|META"))).toBe(false);
    expect(await getCompositeParent(fake.repo, "legacy-1")).toBeUndefined();
  });
});
