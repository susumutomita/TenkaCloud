/**
 * [Composite Runtime / Issue #2062] Tests for the deterministic composite
 * deployment planner. The planner is a pure function — every test runs without
 * AWS SDK / fetch / env / clock / randomness.
 */

import { describe, expect, it } from "vitest";
import {
  buildCompositeDeploymentPlan,
  type CompositeRuntimeDescriptor,
  RuntimeValidationError,
} from "../src/index.js";

const FOUR_PROVIDER: CompositeRuntimeDescriptor = {
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gs://bucket/worker" },
    { id: "azure-edge", provider: "azure", engine: "bicep", entry: "azure/main.bicep" },
    { id: "sakura-svc", provider: "sakura", engine: "apprun", entry: "sakura/service.json" },
  ],
};

const twoTargets = (
  over: Partial<CompositeRuntimeDescriptor> = {},
): CompositeRuntimeDescriptor => ({
  kind: "composite",
  targets: [
    { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
    { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "b" },
  ],
  ...over,
});

describe("buildCompositeDeploymentPlan (#2062)", () => {
  it("should preserve target declaration order", () => {
    const plan = buildCompositeDeploymentPlan({
      kind: "composite",
      targets: [
        { id: "zeta", provider: "aws", engine: "cloudformation", entry: "z.yaml" },
        { id: "alpha", provider: "gcp", engine: "infra-manager", entry: "a" },
        { id: "mu", provider: "azure", engine: "bicep", entry: "m.bicep" },
      ],
    });
    // Declaration order is z, a, m — NOT sorted alphabetically.
    expect(plan.targets.map((t) => t.targetId)).toEqual(["zeta", "alpha", "mu"]);
  });

  it("should assign zero-based contiguous target ordinals", () => {
    const plan = buildCompositeDeploymentPlan(FOUR_PROVIDER);
    expect(plan.targets.map((t) => t.targetOrdinal)).toEqual([0, 1, 2, 3]);
  });

  it("should include AWS, GCP, Azure, and Sakura targets", () => {
    const plan = buildCompositeDeploymentPlan(FOUR_PROVIDER);
    expect(plan.runtimeKind).toBe("composite");
    // [#2747] Every target here is independent (no `dependsOn`), so each carries
    // `executionWave: 0` and empty `dependsOn` / `inputs` / `outputs` dataflow metadata.
    expect(plan.targets).toEqual([
      {
        targetId: "aws-api",
        targetOrdinal: 0,
        executionWave: 0,
        provider: "aws",
        engine: "cloudformation",
        entry: "aws/template.yaml",
        dependsOn: [],
        inputs: {},
        outputs: {},
      },
      {
        targetId: "gcp-worker",
        targetOrdinal: 1,
        executionWave: 0,
        provider: "gcp",
        engine: "infra-manager",
        entry: "gs://bucket/worker",
        dependsOn: [],
        inputs: {},
        outputs: {},
      },
      {
        targetId: "azure-edge",
        targetOrdinal: 2,
        executionWave: 0,
        provider: "azure",
        engine: "bicep",
        entry: "azure/main.bicep",
        dependsOn: [],
        inputs: {},
        outputs: {},
      },
      {
        targetId: "sakura-svc",
        targetOrdinal: 3,
        executionWave: 0,
        provider: "sakura",
        engine: "apprun",
        entry: "sakura/service.json",
        dependsOn: [],
        inputs: {},
        outputs: {},
      },
    ]);
  });

  it("should not mutate the runtime descriptor", () => {
    const input = twoTargets();
    const snapshot = JSON.parse(JSON.stringify(input));
    buildCompositeDeploymentPlan(input);
    expect(input).toEqual(snapshot);
  });

  it("should return a deeply frozen plan", () => {
    const plan = buildCompositeDeploymentPlan(twoTargets());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.targets)).toBe(true);
    expect(Object.isFrozen(plan.targets[0])).toBe(true);
  });

  it("should reject unknown providers", () => {
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [
          { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
          { id: "k8s", provider: "kubernetes", engine: "helm", entry: "Chart.yaml" },
        ],
      }),
    ).toThrow(RuntimeValidationError);
  });

  it("should reject target lists violating the validated contract", () => {
    // Fewer than two targets.
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [{ id: "only", provider: "aws", engine: "cloudformation", entry: "a.yaml" }],
      }),
    ).toThrow(/runtime\.targets/);
    // More than eight targets.
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: Array.from({ length: 9 }, (_, i) => ({
          id: `t-${i}`,
          provider: "aws" as const,
          engine: "cloudformation",
          entry: "a.yaml",
        })),
      }),
    ).toThrow(RuntimeValidationError);
    // Duplicate target ids.
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [
          { id: "dup", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
          { id: "dup", provider: "gcp", engine: "infra-manager", entry: "b" },
        ],
      }),
    ).toThrow(/duplicate target id dup/);
  });

  it("should produce identical plans for equal inputs (deterministic)", () => {
    const a = buildCompositeDeploymentPlan(FOUR_PROVIDER);
    const b = buildCompositeDeploymentPlan(JSON.parse(JSON.stringify(FOUR_PROVIDER)));
    expect(a).toEqual(b);
  });

  /**
   * [#2747] `buildCompositeDeploymentPlan` is a defensive second gate — `normalizeRuntime`
   * (index.ts `validateCompositeGraph`) already rejects cycles / unknown dependencies before a
   * descriptor reaches the planner in the real deploy path, but the planner is exported and
   * callable directly (as these tests do), so it must reject the same shapes on its own.
   */
  it("should reject a dependency cycle reached only through the planner (defensive gate)", () => {
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [
          { id: "a", provider: "aws", engine: "cloudformation", entry: "a.yaml", dependsOn: ["b"] },
          { id: "b", provider: "gcp", engine: "infra-manager", entry: "b", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/dependency cycle includes/);
  });

  it("should reject an unknown dependency reached only through the planner (defensive gate)", () => {
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [
          {
            id: "a",
            provider: "aws",
            engine: "cloudformation",
            entry: "a.yaml",
            dependsOn: ["missing"],
          },
          { id: "b", provider: "gcp", engine: "infra-manager", entry: "b" },
        ],
      }),
    ).toThrow(/unknown dependency missing/);
  });
});
