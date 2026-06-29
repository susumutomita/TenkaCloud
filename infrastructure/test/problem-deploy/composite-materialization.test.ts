/**
 * [Composite Runtime / Issue #2063] Tests for composite materialization.
 *
 * The service is pure orchestration over injected dependencies, so every test
 * pins ids / key / clock through factories and uses spy persistence functions —
 * no AWS, no EventBridge, no adapters.
 */

import {
  buildCompositeDeploymentPlan,
  type CompositeRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  CompositeParentDeploymentItem,
  CompositeTargetDeploymentItem,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-deployment";
import {
  CompositeMaterializationError,
  type MaterializeCompositeDeploymentDeps,
  type MaterializeCompositeDeploymentInput,
  materializeCompositeDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-materialization";

const NOW_MS = 1_700_000_000_000;

const FOUR_PROVIDER: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://bucket/worker" },
    { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
    { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
  ],
};

function makeDeps(over: Partial<MaterializeCompositeDeploymentDeps> = {}) {
  let counter = 0;
  const newDeploymentId = vi.fn(() => `id-${counter++}`);
  const newTeamLoginKey = vi.fn(() => "KEY1");
  const now = vi.fn(() => NOW_MS);
  const createParent = vi.fn(
    async (input) =>
      ({
        ...input,
        PK: `DEPLOYMENT#${input.parentDeploymentId}`,
        SK: "META",
      }) as unknown as CompositeParentDeploymentItem,
  );
  const createTarget = vi.fn(
    async (input) =>
      ({
        ...input,
        PK: `DEPLOYMENT#${input.targetDeploymentId}`,
        SK: "META",
      }) as unknown as CompositeTargetDeploymentItem,
  );
  const deps: MaterializeCompositeDeploymentDeps = {
    createParent,
    createTarget,
    newDeploymentId,
    newTeamLoginKey,
    now,
    ...over,
  };
  return { deps, createParent, createTarget, newDeploymentId, newTeamLoginKey, now };
}

const input = (
  over: Partial<MaterializeCompositeDeploymentInput> = {},
): MaterializeCompositeDeploymentInput => ({
  plan: buildCompositeDeploymentPlan(FOUR_PROVIDER),
  tenantId: "tenant-acme",
  problemId: "cross-cloud",
  teamName: "Alpha",
  awsAccountId: "123456789012",
  region: "ap-northeast-1",
  namePrefix: "tc-cross-cloud-alpha",
  ...over,
});

describe("materializeCompositeDeployment (#2063)", () => {
  it("creates one parent and one target job per plan target", async () => {
    const { deps, createParent, createTarget } = makeDeps();
    const result = await materializeCompositeDeployment(deps, input());

    expect(createParent).toHaveBeenCalledOnce();
    expect(createTarget).toHaveBeenCalledTimes(4);
    expect(Object.keys(result.targetDeploymentIds)).toEqual([
      "aws-api",
      "gcp-worker",
      "azure-edge",
      "sakura-svc",
    ]);
    // Parent id + 4 distinct target ids, all unique.
    const allIds = [result.parentDeploymentId, ...Object.values(result.targetDeploymentIds)];
    expect(new Set(allIds).size).toBe(5);
  });

  it("copies one team login key to parent and all targets", async () => {
    const { deps, createParent, createTarget, newTeamLoginKey } = makeDeps();
    const result = await materializeCompositeDeployment(deps, input());

    expect(newTeamLoginKey).toHaveBeenCalledOnce();
    expect(result.teamLoginKey).toBe("KEY1");
    expect(createParent.mock.calls[0]?.[0].teamLoginKey).toBe("KEY1");
    for (const call of createTarget.mock.calls) {
      expect(call[0].teamLoginKey).toBe("KEY1");
    }
  });

  it("copies request grouping fields to the parent and all targets", async () => {
    const { deps, createParent, createTarget } = makeDeps();
    await materializeCompositeDeployment(
      deps,
      input({ accountGroupId: "accounts-a", problemSetId: "set-1" }),
    );

    expect(createParent.mock.calls[0]?.[0]).toMatchObject({
      accountGroupId: "accounts-a",
      problemSetId: "set-1",
    });
    for (const call of createTarget.mock.calls) {
      expect(call[0]).toMatchObject({
        accountGroupId: "accounts-a",
        problemSetId: "set-1",
      });
    }
  });

  it("preserves AWS GCP Azure Sakura target order and runtime fields", async () => {
    const { deps, createTarget } = makeDeps();
    await materializeCompositeDeployment(deps, input());

    const persisted = createTarget.mock.calls.map((c) => c[0]);
    expect(
      persisted.map((t) => [t.targetOrdinal, t.targetId, t.provider, t.engine, t.entry]),
    ).toEqual([
      [0, "aws-api", "aws", "cloudformation", "aws/template.yaml"],
      [1, "gcp-worker", "gcp", "infra-manager", "gs://bucket/worker"],
      [2, "azure-edge", "azure", "bicep", "azure/main.bicep"],
      [3, "sakura-svc", "sakura", "apprun", "sakura/service.json"],
    ]);
    // Shared fields match across all targets.
    for (const t of persisted) {
      expect(t.tenantId).toBe("tenant-acme");
      expect(t.problemId).toBe("cross-cloud");
      expect(t.teamName).toBe("Alpha");
      expect(t.status).toBe("PENDING");
      expect(t.parentDeploymentId).toBe(persisted[0]?.parentDeploymentId);
    }
  });

  it("does not invoke an adapter or event publisher", async () => {
    // The service has no adapter / event dependency to reach for; the only
    // outward calls are the injected persistence functions. A global fetch must
    // never be touched either.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const { deps, createParent, createTarget } = makeDeps();
    await materializeCompositeDeployment(deps, input());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createParent).toHaveBeenCalledOnce();
    expect(createTarget).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
  });

  it("does not create targets when parent persistence fails", async () => {
    const { deps, createTarget } = makeDeps({
      createParent: vi.fn(async () => {
        throw new Error("parent put failed");
      }),
    });
    await expect(materializeCompositeDeployment(deps, input())).rejects.toThrow(
      /parent put failed/,
    );
    expect(createTarget).not.toHaveBeenCalled();
  });

  it("reports parent id and target id when target persistence fails", async () => {
    let calls = 0;
    const createTarget = vi.fn(async (targetInput) => {
      calls += 1;
      if (calls === 2) throw new Error("target put failed");
      return { ...targetInput } as unknown as CompositeTargetDeploymentItem;
    });
    const { deps } = makeDeps({ createTarget });
    const promise = materializeCompositeDeployment(deps, input());
    await expect(promise).rejects.toBeInstanceOf(CompositeMaterializationError);
    await promise.catch((err: CompositeMaterializationError) => {
      expect(err.failedTargetId).toBe("gcp-worker");
      expect(err.parentDeploymentId).toBe("id-0");
    });
    // The first target (before the failure) was created and not rolled back.
    expect(createTarget).toHaveBeenCalledTimes(2);
  });

  it("wraps a non-Error target failure reason in the materialization error", async () => {
    // A non-Error rejection (string) exercises the String(reason) branch.
    const createTarget = vi.fn(() => Promise.reject("boom-string"));
    const { deps } = makeDeps({ createTarget });
    const err = await materializeCompositeDeployment(deps, input()).catch((e) => e);
    expect(err).toBeInstanceOf(CompositeMaterializationError);
    expect((err as CompositeMaterializationError).message).toContain("boom-string");
    expect((err as CompositeMaterializationError).reason).toBe("boom-string");
  });

  it("uses injected clock and factories deterministically", async () => {
    const { deps, createParent } = makeDeps({ ttlMs: 60_000 });
    const result = await materializeCompositeDeployment(deps, input());

    expect(result.parentDeploymentId).toBe("id-0");
    expect(result.targetDeploymentIds).toEqual({
      "aws-api": "id-1",
      "gcp-worker": "id-2",
      "azure-edge": "id-3",
      "sakura-svc": "id-4",
    });
    expect(result.expiresAt).toBe(Math.floor((NOW_MS + 60_000) / 1000));
    expect(createParent.mock.calls[0]?.[0].createdAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("does not add provider runtime fields to the parent job", async () => {
    const { deps, createParent } = makeDeps();
    await materializeCompositeDeployment(deps, input());

    const parent = createParent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(parent).not.toHaveProperty("provider");
    expect(parent).not.toHaveProperty("engine");
    expect(parent).not.toHaveProperty("entry");
    expect(parent).not.toHaveProperty("runtimeProvider");
    expect(parent).not.toHaveProperty("runtimeEngine");
    expect(parent).not.toHaveProperty("runtimeEntry");
    expect(parent).not.toHaveProperty("targetId");
    // It does carry the coordination fields.
    expect(parent.targetCount).toBe(4);
    expect(parent.status).toBe("PENDING");
  });
});
