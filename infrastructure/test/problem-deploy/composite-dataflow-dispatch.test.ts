import { describe, expect, it, vi } from "vitest";
import type {
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  DeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository";
import type { ControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories";
import {
  type CompositeDispatchDeps,
  dispatchCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-dispatch";

const NOW_ISO = "2026-07-22T00:00:00.000Z";
const PARENT_ID = "parent-dataflow";

function parent(targetCount: number): CompositeParentDeploymentRecord {
  return {
    jobId: PARENT_ID,
    tenantId: "tenant-a",
    problemId: "cross-cloud",
    runtimeKind: "composite",
    compositeVersion: 1,
    targetCount,
    status: "PENDING",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    expiresAt: 9_999_999_999,
  };
}

function target(
  targetId: string,
  ordinal: number,
  over: Partial<CompositeTargetDeploymentRecord> = {},
): CompositeTargetDeploymentRecord {
  return {
    jobId: `job-${targetId}`,
    parentDeploymentId: PARENT_ID,
    targetId,
    targetOrdinal: ordinal,
    tenantId: "tenant-a",
    problemId: "cross-cloud",
    runtimeProvider: targetId.startsWith("aws") ? "aws" : "gcp",
    runtimeEngine: targetId.startsWith("aws") ? "cloudformation" : "infra-manager",
    runtimeEntry: `${targetId}/entry`,
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "Alpha",
    namePrefix: `tc-${targetId}`,
    teamLoginKey: "key",
    status: "PENDING",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    expiresAt: 9_999_999_999,
    ...over,
  };
}

function makeHarness(initialTargets: readonly CompositeTargetDeploymentRecord[]) {
  const parentRow = parent(initialTargets.length);
  const targets = new Map(initialTargets.map((row) => [row.targetId, { ...row }]));
  const failCompositeTargetIfPending = vi.fn(
    async (jobId: string, reason: string, updatedAt: string) => {
      const row = [...targets.values()].find((candidate) => candidate.jobId === jobId);
      if (row?.status === "PENDING") {
        row.status = "FAILED";
        row.failureReason = reason;
        row.updatedAt = updatedAt;
      }
      return { outcome: row ? ("updated" as const) : ("not_found" as const) };
    },
  );
  const repository = {
    getDeployment: vi.fn(async (jobId: string) =>
      jobId === PARENT_ID
        ? parentRow
        : [...targets.values()].find((candidate) => candidate.jobId === jobId),
    ),
    listCompositeTargets: vi.fn(async () => [...targets.values()]),
    failCompositeTargetIfPending,
  } as unknown as DeploymentsRepository;
  const runtime = {
    resolveDeploymentsRepository: vi.fn(async () => repository),
  } as unknown as ControlDataRuntime;
  const deployByTarget = new Map<string, ReturnType<typeof vi.fn>>();
  const selectAdapter: CompositeDispatchDeps["selectAdapter"] = (_runtime, row) => {
    const deploy = deployByTarget.get(row.targetId) ?? vi.fn(async () => ({ status: "deploying" }));
    deployByTarget.set(row.targetId, deploy);
    return { deploy };
  };
  const deps: CompositeDispatchDeps = {
    repo: { runtime, ddb: { send: vi.fn() }, tableName: "Deployments" },
    resolveConnection: vi.fn(async (input) =>
      input.provider === "aws"
        ? {
            provider: "aws" as const,
            awsAccountId: input.awsAccountId,
            region: input.region,
            competitorRoleArn: "arn:aws:iam::123456789012:role/Deploy",
            externalIdParameterName: "/tenant/external-id",
          }
        : { provider: input.provider, teamSlug: input.teamSlug },
    ),
    selectAdapter,
    problemsCatalog: { "cross-cloud": "problems/cross-cloud" },
    now: () => Date.parse(NOW_ISO),
  };
  return { deps, targets, deployByTarget, failCompositeTargetIfPending };
}

describe("Composite dataflow dispatch (#2747)", () => {
  it("should start independent targets concurrently and leave dependents waiting", async () => {
    const harness = makeHarness([
      target("gcp-a", 0),
      target("gcp-b", 1),
      target("aws-final", 2, {
        compositeDependsOn: ["gcp-a", "gcp-b"],
        compositeInputs: {
          GcpA: { fromTarget: "gcp-a", output: "Endpoint" },
        },
      }),
    ]);
    let active = 0;
    let maximumActive = 0;
    for (const targetId of ["gcp-a", "gcp-b"]) {
      const deploy = vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return { status: "deploying" };
      });
      harness.deployByTarget.set(targetId, deploy);
    }

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(maximumActive).toBe(2);
    expect(result.targets.map(({ targetId, outcome }) => [targetId, outcome])).toEqual([
      ["gcp-a", "started"],
      ["gcp-b", "started"],
      ["aws-final", "waiting"],
    ]);
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should inject only declared bound outputs after every dependency completes", async () => {
    const harness = makeHarness([
      target("gcp-a", 0, {
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Endpoint: "https://gcp.example", Ignored: "no" }),
        compositeOutputs: { Endpoint: { sensitivity: "public" } },
      }),
      target("aws-final", 1, {
        compositeDependsOn: ["gcp-a"],
        compositeInputs: {
          GcpEndpoint: { fromTarget: "gcp-a", output: "Endpoint" },
        },
      }),
    ]);
    const deploy = vi.fn(async () => ({ status: "deploying" }));
    harness.deployByTarget.set("aws-final", deploy);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    // gcp-a is already COMPLETE from a prior tick — re-dispatching it is a no-op ("already_active"),
    // consistent with the "does not invoke a target that is not PENDING" contract.
    expect(result.targets[0]?.outcome).toBe("already_active");
    expect(result.targets[1]?.outcome).toBe("started");
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { GcpEndpoint: "https://gcp.example" } }),
    );
  });

  it("should block downstream targets after an upstream failure without provider calls", async () => {
    const harness = makeHarness([
      target("gcp-a", 0, { status: "FAILED" }),
      target("aws-final", 1, { compositeDependsOn: ["gcp-a"] }),
    ]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets[1]?.outcome).toBe("blocked");
    expect(harness.targets.get("aws-final")?.status).toBe("FAILED");
    expect(harness.targets.get("aws-final")?.failureReason).toBe("dependency blocked: gcp-a");
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should fail loudly for missing and disallowed sensitive output bindings", async () => {
    const missing = makeHarness([
      target("gcp-a", 0, {
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Other: "value" }),
        compositeOutputs: { Endpoint: { sensitivity: "public" } },
      }),
      target("aws-final", 1, {
        compositeDependsOn: ["gcp-a"],
        compositeInputs: { Endpoint: { fromTarget: "gcp-a", output: "Endpoint" } },
      }),
    ]);
    await dispatchCompositeDeployment(missing.deps, PARENT_ID);
    expect(missing.targets.get("aws-final")?.failureReason).toBe(
      "binding failed: missing output gcp-a.Endpoint",
    );

    const sensitive = makeHarness([
      target("gcp-a", 0, {
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Secret: "never-log-this" }),
        compositeOutputs: { Secret: { sensitivity: "sensitive" } },
      }),
      target("aws-final", 1, {
        compositeDependsOn: ["gcp-a"],
        compositeInputs: { SecretParam: { fromTarget: "gcp-a", output: "Secret" } },
      }),
    ]);
    await dispatchCompositeDeployment(sensitive.deps, PARENT_ID);
    const reason = sensitive.targets.get("aws-final")?.failureReason ?? "";
    expect(reason).toBe("binding failed: sensitive output gcp-a.Secret not allowed");
    expect(reason).not.toContain("never-log-this");
  });

  it("should fail loudly when a Composite dependency references an unknown target", async () => {
    const harness = makeHarness([target("aws-final", 0, { compositeDependsOn: ["ghost"] })]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("blocked");
    expect(harness.targets.get("aws-final")?.failureReason).toBe(
      "dependency blocked: unknown ghost",
    );
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should fail loudly when a Composite binding references an unknown upstream target", async () => {
    const harness = makeHarness([
      target("aws-final", 0, {
        compositeInputs: { Param: { fromTarget: "ghost", output: "Endpoint" } },
      }),
    ]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("blocked");
    expect(harness.targets.get("aws-final")?.failureReason).toBe(
      "binding failed: unknown upstream ghost",
    );
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should fail loudly when a Composite binding references an undeclared output", async () => {
    const harness = makeHarness([
      target("gcp-a", 0, {
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Endpoint: "https://gcp.example" }),
        compositeOutputs: {}, // Endpoint intentionally not declared
      }),
      target("aws-final", 1, {
        compositeDependsOn: ["gcp-a"],
        compositeInputs: { Param: { fromTarget: "gcp-a", output: "Endpoint" } },
      }),
    ]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets.find((t) => t.targetId === "aws-final")?.outcome).toBe("blocked");
    expect(harness.targets.get("aws-final")?.failureReason).toBe(
      "binding failed: undeclared output gcp-a.Endpoint",
    );
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should fail preflight loudly for an unrecognized runtime provider", async () => {
    const harness = makeHarness([target("aws-final", 0, { runtimeProvider: "unknown-cloud" })]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("preflight_failed");
    expect(harness.targets.get("aws-final")?.failureReason).toBe(
      "preflight failed: unknown provider",
    );
    expect(harness.deployByTarget.has("aws-final")).toBe(false);
  });

  it("should fail preflight loudly when adapter selection throws", async () => {
    const harness = makeHarness([target("gcp-a", 0)]);
    const deps = {
      ...harness.deps,
      selectAdapter: () => {
        throw new Error("no adapter registered");
      },
    };

    const result = await dispatchCompositeDeployment(deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("preflight_failed");
    expect(harness.targets.get("gcp-a")?.failureReason).toBe("preflight failed: Error");
  });

  it("should fail preflight loudly when the problem is missing from the catalog", async () => {
    const harness = makeHarness([target("gcp-a", 0, { problemId: "unlisted-problem" })]);

    const result = await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("preflight_failed");
    expect(harness.targets.get("gcp-a")?.failureReason).toBe(
      "preflight failed: unknown problem unlisted-problem",
    );
    expect(harness.deployByTarget.get("gcp-a")).not.toHaveBeenCalled();
  });

  it("should record a generic non-secret reason when a thrown value is not an Error", async () => {
    const harness = makeHarness([target("gcp-a", 0)]);
    const deps = {
      ...harness.deps,
      resolveConnection: async () => {
        throw "connection string thrown, not an Error instance";
      },
    };

    const result = await dispatchCompositeDeployment(deps, PARENT_ID);

    expect(result.targets[0]?.outcome).toBe("preflight_failed");
    expect(harness.targets.get("gcp-a")?.failureReason).toBe("preflight failed: unknown error");
  });

  it("should allow explicitly classified sensitive propagation without duplicating completed work", async () => {
    const harness = makeHarness([
      target("gcp-a", 0, {
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Secret: "bound-value" }),
        compositeOutputs: { Secret: { sensitivity: "sensitive" } },
      }),
      target("aws-final", 1, {
        compositeDependsOn: ["gcp-a"],
        compositeInputs: {
          SecretParam: { fromTarget: "gcp-a", output: "Secret", allowSensitive: true },
        },
      }),
    ]);
    const deploy = vi.fn(async () => ({ status: "deploying" }));
    harness.deployByTarget.set("aws-final", deploy);

    await dispatchCompositeDeployment(harness.deps, PARENT_ID);
    const awsFinal = harness.targets.get("aws-final");
    if (!awsFinal) throw new Error("expected aws-final target row to exist");
    awsFinal.status = "IN_PROGRESS";
    await dispatchCompositeDeployment(harness.deps, PARENT_ID);

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { SecretParam: "bound-value" } }),
    );
  });
});
