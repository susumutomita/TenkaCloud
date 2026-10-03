/**
 * [Composite Runtime / Issue #2075] Tests for the composite deploy orchestrator.
 *
 * The orchestrator is pure routing over injected collaborators (plan builder,
 * quota enforcer, materialize, dispatch, clock), so every test pins them with
 * spies — no AWS, no DynamoDB, no EventBridge, no adapters.
 */

import { buildCompositeDeploymentPlan } from "@tenkacloud/problem-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CompositeAwsInputRequiredError,
  type CompositeDeployDeps,
  type CompositeDeployInvocation,
  planHasAwsTarget,
  startCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-deploy";
import type { CompositeDispatchResult } from "../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch";
import type { MaterializeCompositeDeploymentResult } from "../../lib/problem-deploy/handlers/deploy-handler/composite-materialization";
import { DeployQuotaExceededError } from "../../lib/problem-deploy/handlers/deploy-handler/deploy-quota";
import type { CompositeRuntimeDescriptor } from "../../lib/problem-deploy/handlers/shared/runtime";

const EXPIRES_AT = 1_700_000_028_800;
const PARENT_ID = "parent-1";

// The AcceptanceCriteria 4-provider fixture: AWS, GCP, Azure, Sakura.
const FOUR_PROVIDER: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://bucket/worker" },
    { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
    { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
  ],
};

// An Azure + Sakura only composite — no AWS target.
const NO_AWS: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: [
    { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
    { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
  ],
};

function dispatchResultFor(
  descriptor: CompositeRuntimeDescriptor,
  outcomeFor: (targetId: string) => "started" | "preflight_failed" | "dispatch_failed" = () =>
    "started",
): CompositeDispatchResult {
  return {
    parentDeploymentId: PARENT_ID,
    targets: descriptor.targets.map((t, i) => ({
      targetId: t.id,
      targetDeploymentId: `td-${i}`,
      outcome: outcomeFor(t.id),
    })),
  };
}

function makeDeps(over: Partial<CompositeDeployDeps> = {}): {
  deps: CompositeDeployDeps;
  enforceQuota: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const enforceQuota = vi.fn(async () => {});
  const materialize = vi.fn(
    async (): Promise<MaterializeCompositeDeploymentResult> => ({
      parentDeploymentId: PARENT_ID,
      teamLoginKey: "KEY1",
      targetDeploymentIds: {},
      expiresAt: EXPIRES_AT,
    }),
  );
  const dispatch = vi.fn(async () => dispatchResultFor(FOUR_PROVIDER));
  const deps: CompositeDeployDeps = {
    buildPlan: buildCompositeDeploymentPlan,
    enforceQuota,
    materialize,
    dispatch,
    tenantId: "tenant-acme",
    ...over,
  };
  return { deps, enforceQuota, materialize, dispatch };
}

const invocation = (over: Partial<CompositeDeployInvocation> = {}): CompositeDeployInvocation => ({
  problemId: "cross-cloud",
  descriptor: FOUR_PROVIDER,
  teamName: "Alpha Team",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  quotaTier: "basic",
  ...over,
});

describe("startCompositeDeployment (#2075)", () => {
  it("should route a composite runtime to materialization and target dispatch", async () => {
    const { deps, materialize, dispatch } = makeDeps();

    await startCompositeDeployment(deps, invocation());

    expect(materialize).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(PARENT_ID);
    // materialize is called before dispatch.
    expect(materialize.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0],
    );
    // the plan carries all four targets in declared order.
    const planArg = materialize.mock.calls[0][0].plan;
    expect(planArg.targets.map((t: { provider: string }) => t.provider)).toEqual([
      "aws",
      "gcp",
      "azure",
      "sakura",
    ]);
  });

  it("should return parent job id in the existing response shape", async () => {
    const { deps } = makeDeps();

    const res = await startCompositeDeployment(deps, invocation());

    expect(res).toEqual({
      jobId: PARENT_ID,
      status: "PENDING",
      namePrefix: "tc-cross-cloud-alpha-team",
      teamLoginKey: "KEY1",
      expiresAt: EXPIRES_AT,
    });
    // No extra/new required field beyond the legacy DeployResponse contract.
    expect(Object.keys(res).sort()).toEqual(
      ["expiresAt", "jobId", "namePrefix", "status", "teamLoginKey"].sort(),
    );
  });

  it("should return parent response when one target dispatch fails", async () => {
    const dispatch = vi.fn(async () =>
      dispatchResultFor(FOUR_PROVIDER, (id) =>
        id === "azure-edge" ? "dispatch_failed" : "started",
      ),
    );
    const { deps } = makeDeps({ dispatch });

    const res = await startCompositeDeployment(deps, invocation());

    // The parent response is returned unchanged — failure lives in the target rows.
    expect(res.jobId).toBe(PARENT_ID);
    expect(res.status).toBe("PENDING");
  });

  it("should not dispatch when materialization fails", async () => {
    const dispatch = vi.fn(async () => dispatchResultFor(FOUR_PROVIDER));
    const materialize = vi.fn(async () => {
      throw new Error("createTarget failed");
    });
    const { deps } = makeDeps({ materialize, dispatch });

    await expect(startCompositeDeployment(deps, invocation())).rejects.toThrow(
      /createTarget failed/,
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("should not require AWS input for Azure and Sakura only composite", async () => {
    const dispatch = vi.fn(async () => dispatchResultFor(NO_AWS));
    const { deps, materialize } = makeDeps({ dispatch });

    const res = await startCompositeDeployment(
      deps,
      invocation({ descriptor: NO_AWS, awsAccountId: undefined, region: undefined }),
    );

    expect(res.jobId).toBe(PARENT_ID);
    expect(materialize).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    // No AWS account/region was supplied — materialize received empty strings.
    expect(materialize.mock.calls[0][0].awsAccountId).toBe("");
    expect(materialize.mock.calls[0][0].region).toBe("");
  });

  it("should require AWS input when a composite includes AWS target", async () => {
    const { deps, materialize, dispatch } = makeDeps();

    await expect(
      startCompositeDeployment(deps, invocation({ awsAccountId: undefined, region: undefined })),
    ).rejects.toBeInstanceOf(CompositeAwsInputRequiredError);
    // The guard fires before any write or dispatch.
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("should enforce deploy quota once per composite parent request", async () => {
    const { deps, enforceQuota, materialize } = makeDeps();

    await startCompositeDeployment(deps, invocation());

    // Once for the whole parent, NOT once per (four) targets.
    expect(enforceQuota).toHaveBeenCalledOnce();
    expect(enforceQuota).toHaveBeenCalledWith("tenant-acme", "basic");
    // and quota is enforced before materialization.
    expect(enforceQuota.mock.invocationCallOrder[0]).toBeLessThan(
      materialize.mock.invocationCallOrder[0],
    );
  });

  it("should not materialize or dispatch when the quota is exceeded", async () => {
    const enforceQuota = vi.fn(async () => {
      throw new DeployQuotaExceededError("basic", 2, 2);
    });
    const { deps, materialize, dispatch } = makeDeps({ enforceQuota });

    await expect(startCompositeDeployment(deps, invocation())).rejects.toBeInstanceOf(
      DeployQuotaExceededError,
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("should fail before any write when the descriptor is malformed", async () => {
    const buildPlan = vi.fn(() => {
      throw new Error("invalid composite descriptor");
    });
    const { deps, enforceQuota, materialize, dispatch } = makeDeps({ buildPlan });

    await expect(startCompositeDeployment(deps, invocation())).rejects.toThrow(
      /invalid composite descriptor/,
    );
    expect(enforceQuota).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("planHasAwsTarget (#2075)", () => {
  it("should be true for a plan with an AWS target and false otherwise", () => {
    expect(planHasAwsTarget(buildCompositeDeploymentPlan(FOUR_PROVIDER))).toBe(true);
    expect(planHasAwsTarget(buildCompositeDeploymentPlan(NO_AWS))).toBe(false);
  });
});
