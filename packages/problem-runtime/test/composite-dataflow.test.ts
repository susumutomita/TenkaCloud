import { describe, expect, it } from "vitest";
import {
  buildCompositeDeploymentPlan,
  type CompositeRuntimeTarget,
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

/**
 * `buildCompositeDeploymentPlan` (unlike `composite()` above) takes the strict
 * `CompositeRuntimeDescriptor`, so its `sensitivity` / binding literal unions need the fixtures
 * cast once at the one call site that skips `normalizeRuntime`'s validation-then-narrow — the
 * `gcp` / `aws` consts themselves stay loosely typed so `composite([gcp, aws])` keeps accepting
 * them structurally everywhere else in this file.
 */
function asCompositeTarget(target: Record<string, unknown>): CompositeRuntimeTarget {
  return target as unknown as CompositeRuntimeTarget;
}

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

    expect(plan.waves).toEqual([["gcp-service", "azure-observer"], ["aws-workload"]]);
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
    expect(() => composite([gcp, { ...aws, dependsOn: ["missing"] }])).toThrow(
      /unknown dependency missing/,
    );
    expect(() => composite([gcp, { ...aws, dependsOn: ["aws-workload"] }])).toThrow(
      /cannot depend on itself/,
    );
    expect(() => composite([gcp, { ...aws, dependsOn: ["gcp-service", "gcp-service"] }])).toThrow(
      /duplicate dependency gcp-service/,
    );
  });

  it("should reject cycles before planning or persistence", () => {
    expect(() => composite([{ ...gcp, dependsOn: ["aws-workload"] }, aws])).toThrow(
      /dependency cycle/,
    );
  });

  it("should require binding sources to be explicit dependencies", () => {
    expect(() => composite([gcp, { ...aws, dependsOn: [] }])).toThrow(
      /must also appear in dependsOn/,
    );
  });

  it("should require the upstream target to declare the referenced output", () => {
    expect(() => composite([{ ...gcp, outputs: {} }, aws])).toThrow(
      /does not declare output project_number/,
    );
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

  it("should reject a binding parameter name that collides with a platform-injected reserved name", () => {
    expect(() =>
      composite([
        gcp,
        {
          ...aws,
          inputs: {
            NamePrefix: { fromTarget: "gcp-service", output: "project_number" },
          },
        },
      ]),
    ).toThrow(/parameter name NamePrefix is reserved for provider aws/);

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
            tenkacloud_team: { fromTarget: "gcp-service", output: "project_number" },
          },
        },
      ]),
    ).toThrow(/parameter name tenkacloud_team is reserved for provider gcp/);
  });

  it("should reject malformed output declarations and bindings", () => {
    expect(() => composite([{ ...gcp, outputs: [] }, aws])).toThrow(/outputs must be an object/);
    expect(() =>
      composite([{ ...gcp, outputs: { project_number: { sensitivity: "secret" } } }, aws]),
    ).toThrow(/sensitivity must be public or sensitive/);
    expect(() => composite([gcp, { ...aws, inputs: [] }])).toThrow(/inputs must be an object/);
  });

  it("should report planner-only defensive graph failures as RuntimeValidationError", () => {
    expect(() =>
      buildCompositeDeploymentPlan({
        kind: "composite",
        targets: [asCompositeTarget({ ...gcp, dependsOn: ["missing"] }), asCompositeTarget(aws)],
      }),
    ).toThrow(RuntimeValidationError);
  });

  describe("shape validation detail (#2747)", () => {
    it("should reject an output declaration with an invalid name", () => {
      expect(() =>
        composite([{ ...gcp, outputs: { "1bad-name": { sensitivity: "public" } } }, aws]),
      ).toThrow(/output name is invalid/);
    });

    it("should reject an output declaration that is not an object", () => {
      expect(() =>
        composite([{ ...gcp, outputs: { project_number: "not-an-object" } }, aws]),
      ).toThrow(/output declaration must be an object/);
    });

    it("should reject a dependsOn entry that is not a valid target id", () => {
      expect(() => composite([gcp, { ...aws, dependsOn: ["Not Valid!!"] }])).toThrow(
        /dependency must be a valid target id/,
      );
    });

    it("should reject a binding that is not an object", () => {
      expect(() =>
        composite([gcp, { ...aws, inputs: { GcpProjectNumber: "not-an-object" } }]),
      ).toThrow(/binding must be an object/);
    });

    it("should reject a binding whose fromTarget is not a valid target id", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            inputs: {
              GcpProjectNumber: { fromTarget: "Not Valid!!", output: "project_number" },
            },
          },
        ]),
      ).toThrow(/fromTarget must be a valid target id/);
    });

    it("should reject a binding whose output name is invalid", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            inputs: { GcpProjectNumber: { fromTarget: "gcp-service", output: "1bad" } },
          },
        ]),
      ).toThrow(/output name is invalid/);
    });

    it("should reject a binding whose allowSensitive is not a boolean", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            inputs: {
              GcpProjectNumber: {
                fromTarget: "gcp-service",
                output: "project_number",
                allowSensitive: "yes",
              },
            },
          },
        ]),
      ).toThrow(/allowSensitive must be boolean/);
    });

    it("should reject a binding whose fromTarget references no target at all in the graph", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            dependsOn: [],
            inputs: {
              GcpProjectNumber: { fromTarget: "totally-missing", output: "project_number" },
            },
          },
        ]),
      ).toThrow(/unknown upstream target totally-missing/);
    });

    it("should reject a binding whose fromTarget is not even a string", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            inputs: { GcpProjectNumber: { fromTarget: 42, output: "project_number" } },
          },
        ]),
      ).toThrow(/fromTarget must be a valid target id/);
    });

    it("should reject a dependsOn that is not an array", () => {
      expect(() => composite([gcp, { ...aws, dependsOn: "not-an-array" }])).toThrow(
        /dependsOn must be an array/,
      );
    });

    it("should fall back to <unknown> in the parameter-name message for a non-string provider", () => {
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            provider: 123,
            inputs: { "1bad": { fromTarget: "gcp-service", output: "project_number" } },
          },
        ]),
      ).toThrow(/parameter name is invalid for provider <unknown>/);
    });

    it("should treat a provider outside the reserved-name table as never reserved", () => {
      // "unknown-cloud" has no entry in RESERVED_COMPOSITE_PARAMETER_NAMES, so every otherwise
      // well-formed parameter name for it passes the reserved-name check.
      expect(() =>
        composite([
          gcp,
          {
            ...aws,
            provider: "unknown-cloud",
            inputs: {
              GcpProjectNumber: { fromTarget: "gcp-service", output: "project_number" },
            },
          },
        ]),
      ).not.toThrow();
    });

    it("should omit inputs/outputs from the normalized target when declared but empty", () => {
      const result = composite([
        { ...gcp, outputs: {} },
        { ...aws, inputs: {} },
      ]);
      if (!result || !("targets" in result)) throw new Error("expected composite runtime");
      const [normalizedGcp, normalizedAws] = result.targets;
      expect(normalizedGcp).not.toHaveProperty("outputs");
      expect(normalizedAws).not.toHaveProperty("inputs");
      // dependsOn survives independently of inputs (no binding required to depend on a target).
      expect(normalizedAws?.dependsOn).toEqual(["gcp-service"]);
    });
  });
});
