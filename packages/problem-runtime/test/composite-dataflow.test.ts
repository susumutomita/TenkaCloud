import { describe, expect, it } from "vitest";
import {
  buildCompositeDeploymentPlan,
  normalizeRuntime,
  RuntimeValidationError,
} from "../src/index.js";

function composite(targets: readonly Record<string, unknown>[]) {
  return normalizeRuntime({ id: "cross-cloud", runtime: { kind: "composite", targets } });
}

const gcp = {
  id: "gcp-service",
  provider: "gcp",
  engine: "infra-manager",
  entry: "gcp/terraform",
  outputs: {
    project_number: { sensitivity: "public" },
    signing_key: { sensitivity: "sensitive" },
  },
};

const aws = {
  id: "aws-workload",
  provider: "aws",
  engine: "cloudformation",
  entry: "aws/template.yaml",
  dependsOn: ["gcp-service"],
  inputs: {
    GcpProjectNumber: { fromTarget: "gcp-service", output: "project_number" },
  },
};

describe("Composite Runtime dataflow (#2747)", () => {
  it("should normalize an acyclic graph with explicit public bindings", () => {
    expect(composite([gcp, aws])).toEqual({
      kind: "composite",
      targets: [gcp, aws],
    });
  });

  it("should build stable waves while running independent targets together", () => {
    const azure = {
      id: "azure-observer",
      provider: "azure",
      engine: "bicep",
      entry: "azure/main.bicep",
    };
    const runtime = composite([gcp, azure, aws]);
    if (!runtime || !("kind" in runtime)) throw new Error("expected composite runtime");

    const plan = buildCompositeDeploymentPlan(runtime);

    expect(plan.waves).toEqual([
      ["gcp-service", "azure-observer"],
      ["aws-workload"],
    ]);
    expect(plan.targets.map((target) => [target.targetId, target.executionWave])).toEqual([
      ["gcp-service", 0],
      ["azure-observer", 0],
      ["aws-workload", 1],
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.waves)).toBe(true);
    expect(Object.isFrozen(plan.targets[2]?.inputs)).toBe(true);
  });

  it("should reject unknown, self, and duplicate dependencies", () => {
    expect(() =>
      composite([
        gcp,
        { ...aws, dependsOn: ["missing"] },
      ]),
    ).toThrow(/unknown dependency missing/);
    expect(() =>
      composite([
        gcp,
        { ...aws, dependsOn: ["aws-workload"] },
      ]),
    ).toThrow(/cannot depend on itself/);
    expect(() =>
      composite([
        gcp,
        { ...aws, dependsOn: ["gcp-service", "gcp-service"] },
      ]),
    ).toThrow(/duplicate dependency gcp-service/);
  });

  it("should reject cycles before planning or persistence", () => {
    expect(() =>
      composite([
        { ...gcp, dependsOn: ["aws-workload"] },
        aws,
      ]),
    ).toThrow(/dependency cycle/);
  });

  it("should require binding sources to be explicit dependencies", () => {
    expect(() =>
      composite([
        gcp,
        { ...aws, dependsOn: [] },
      ]),
    ).toThrow(/must also appear in dependsOn/);
  });

  it("should require the upstream target to declare the referenced output", () => {
    expect(() =>
      composite([
        { ...gcp, outputs: {} },
        aws,
      ]),
    ).toThrow(/does not declare output project_number/);
  });

  it("should require an explicit allowSensitive flag for sensitive output propagation", () => {
    const sensitiveAws = {
      ...aws,
      inputs: {
        SigningKey: { fromTarget: "gcp-service", output: "signing_key" },
      },
    };
    expect(() => composite([gcp, sensitiveAws])).toThrow(/requires allowSensitive: true/);

    expect(
      composite([
        gcp,
        {
          ...sensitiveAws,
          inputs: {
            SigningKey: {
              fromTarget: "gcp-service",
              output: "signing_key",
              allowSensitive: true,
            },
          },
        },
      ]),
    ).toBeDefined();
  });

  it("should validate provider parameter names before any cloud mutation", () => {
    expect(() =>
      composite([
        gcp,
        {
          ...aws,
          inputs: {
            "invalid-aws-parameter": {
              fromTarget: "gcp-service",
              output: "project_number",
            },
          },
        },
      ]),
    ).toThrow(/parameter name is invalid for provider aws/);

    expect(() =>
      composite([
        gcp,
        {
          id: "gcp-downstream",
          provider: "gcp",
          engine: "infra-manager",
          entry: "gcp/downstream",
          dependsOn: ["gcp-service"],
          inputs: {
            "invalid-variable": {
              fromTarget: "gcp-service",
              output: "project_number",
            },
          },
        },
      ]),
    ).toThrow(/parameter name is invalid for provider gcp/);
  });

  it("should reject malformed output declarations and bindings", () => {
    expect(() => composite([{ ...gcp, outputs: [] }, aws])).toThrow(/outputs must be an object/);
    expect(() =>
      composite([
        { ...gcp, outputs: { project_number: { sensitivity: "secret" } } },
        aws,
      ]),
    ).toThrow(/sensitivity must be public or sensitive/);
    expect(() => composite([gcp, { ...aws, inputs: [] }])).toThrow(/inputs must be an object/);
  });

  it("should report planner-only defensive graph failures as RuntimeValidationError", () => {
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [
          { ...gcp, dependsOn: ["missing"] },
          aws,
        ],
      }),
    ).toThrow(RuntimeValidationError);
  });
});
