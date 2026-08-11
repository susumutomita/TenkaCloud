import { describe, expect, it } from "vitest";
import {
  CONTAINER_RUNTIMES,
  type CompositeRuntimeDescriptor,
  classifyRuntimeSupport,
  DEFAULT_ENTRY,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isCompositeRuntime,
  isContainerRuntime,
  isExecutableRuntime,
  isReservedRuntime,
  isSingleRuntime,
  normalizeRuntime,
  type ProblemRuntimeDescriptor,
  RESERVED_RUNTIMES,
  type RuntimeDescriptor,
  RuntimeValidationError,
} from "../src/index.js";

const AWS: RuntimeDescriptor = {
  provider: "aws",
  engine: "cloudformation",
  entry: "template.yaml",
};

const CONTAINER: RuntimeDescriptor = {
  provider: "docker",
  engine: "compose",
  entry: "local/docker-compose.yml",
};

describe("constants", () => {
  it("should pin the single executable provider/engine and default entry", () => {
    expect(EXECUTABLE_PROVIDER).toBe("aws");
    expect(EXECUTABLE_ENGINE).toBe("cloudformation");
    expect(DEFAULT_ENTRY).toBe("template.yaml");
  });

  it("should reserve exactly the three provider/engine roadmap pairs in order", () => {
    expect(RESERVED_RUNTIMES).toEqual([
      { provider: "sakura", engine: "apprun" },
      { provider: "azure", engine: "bicep" },
      { provider: "gcp", engine: "infra-manager" },
    ]);
  });

  it("should recognize the local container runtime (docker/compose)", () => {
    expect(CONTAINER_RUNTIMES).toEqual([{ provider: "docker", engine: "compose" }]);
  });
});

describe("normalizeRuntime", () => {
  it("should pass through an explicit, well-formed runtime block", () => {
    expect(
      normalizeRuntime({ runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" } }),
    ).toEqual({ provider: "azure", engine: "bicep", entry: "main.bicep" });
  });

  it("should return undefined for a malformed runtime block (missing entry)", () => {
    expect(
      normalizeRuntime({ runtime: { provider: "aws", engine: "cloudformation" } }),
    ).toBeUndefined();
  });

  it("should return undefined when a runtime field has the wrong type", () => {
    expect(
      normalizeRuntime({ runtime: { provider: "aws", engine: 7, entry: "template.yaml" } }),
    ).toBeUndefined();
  });

  it("should normalize a legacy cfnTemplate-only problem to aws/cloudformation", () => {
    expect(normalizeRuntime({ cfnTemplate: "stack.yaml" })).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "stack.yaml",
    });
  });

  it("should default to template.yaml when neither runtime nor cfnTemplate is declared", () => {
    expect(normalizeRuntime({})).toEqual(AWS);
  });

  it("should fall back to the default entry when cfnTemplate is a non-string", () => {
    expect(normalizeRuntime({ cfnTemplate: 42 })).toEqual(AWS);
  });

  it("should treat runtime:null as absent (fall through to default, never throw)", () => {
    expect(normalizeRuntime({ runtime: null })).toEqual(AWS);
  });
});

describe("composite runtime normalization", () => {
  it("should accept a valid composite runtime with two targets", () => {
    expect(
      normalizeRuntime({
        id: "cross-cloud",
        runtime: {
          kind: "composite",
          targets: [
            {
              id: "aws-api",
              provider: "aws",
              engine: "cloudformation",
              entry: "aws/template.yaml",
            },
            { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
          ],
        },
      }),
    ).toEqual({
      kind: "composite",
      targets: [
        { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "aws/template.yaml" },
        { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
      ],
    });
  });

  it("should reject composite runtime with fewer than two targets", () => {
    expect(() =>
      normalizeRuntime({
        id: "too-small",
        runtime: {
          kind: "composite",
          targets: [
            {
              id: "aws-api",
              provider: "aws",
              engine: "cloudformation",
              entry: "aws/template.yaml",
            },
          ],
        },
      }),
    ).toThrow(RuntimeValidationError);
  });

  it("should reject composite runtime with more than eight targets", () => {
    expect(() =>
      normalizeRuntime({
        id: "too-large",
        runtime: {
          kind: "composite",
          targets: Array.from({ length: 9 }, (_, index) => ({
            id: `target-${index}`,
            provider: "aws",
            engine: "cloudformation",
            entry: "template.yaml",
          })),
        },
      }),
    ).toThrow(/too-large:runtime.targets/);
  });

  it("should reject duplicate target ids", () => {
    expect(() =>
      normalizeRuntime({
        id: "dupe",
        runtime: {
          kind: "composite",
          targets: [
            { id: "same", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
            { id: "same", provider: "gcp", engine: "infra-manager", entry: "b" },
          ],
        },
      }),
    ).toThrow(/dupe:runtime.targets\[1\].id/);
  });

  it("should reject invalid target id", () => {
    expect(() =>
      normalizeRuntime({
        id: "bad-id",
        runtime: {
          kind: "composite",
          targets: [
            { id: "Aws", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
            { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "b" },
          ],
        },
      }),
    ).toThrow(/bad-id:runtime.targets\[0\].id/);
  });

  it("should reject nested composite target", () => {
    expect(() =>
      normalizeRuntime({
        id: "nested",
        runtime: {
          kind: "composite",
          targets: [
            {
              id: "aws-api",
              provider: "aws",
              engine: "cloudformation",
              entry: "a.yaml",
              kind: "composite",
            },
            { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "b", targets: [] },
          ],
        },
      }),
    ).toThrow(/nested:runtime.targets\[0\].kind/);
  });

  it("should keep explicit single runtime normalization unchanged", () => {
    expect(
      normalizeRuntime({ runtime: { provider: "aws", engine: "cloudformation", entry: "x.yaml" } }),
    ).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "x.yaml",
    });
  });

  it("should reject composite runtime whose targets is not an array", () => {
    expect(() =>
      normalizeRuntime({
        id: "no-targets",
        runtime: { kind: "composite", targets: "nope" },
      }),
    ).toThrow(/no-targets:runtime\.targets: composite runtime requires targets/);
  });

  it("should reject a target that is not an object", () => {
    expect(() =>
      normalizeRuntime({
        id: "bad-target",
        runtime: {
          kind: "composite",
          targets: [
            { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
            "not-an-object",
          ],
        },
      }),
    ).toThrow(/bad-target:runtime\.targets\[1\]: target must be an object/);
  });

  it("should reject a target with an empty-string provider/engine/entry", () => {
    expect(() =>
      normalizeRuntime({
        id: "empty-fields",
        runtime: {
          kind: "composite",
          targets: [
            { id: "aws-api", provider: "", engine: "cloudformation", entry: "a.yaml" },
            { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "b" },
          ],
        },
      }),
    ).toThrow(/empty-fields:runtime\.targets\[0\]\.provider: provider must be a non-empty string/);
  });

  it("should default the problemId to <unknown> when metadata has no id", () => {
    expect(() =>
      normalizeRuntime({
        runtime: {
          kind: "composite",
          targets: [{ id: "only", provider: "aws", engine: "cloudformation", entry: "a.yaml" }],
        },
      }),
    ).toThrow(/<unknown>:runtime\.targets/);
  });

  it("should return undefined for a truthy non-object runtime", () => {
    // A non-null, non-undefined runtime that is not a record (string / number /
    // array) is malformed → undefined, never throws.
    expect(normalizeRuntime({ runtime: "not-an-object" })).toBeUndefined();
    expect(normalizeRuntime({ runtime: ["aws"] })).toBeUndefined();
  });
});

describe("composite runtime type guards / classification", () => {
  const COMPOSITE: CompositeRuntimeDescriptor = {
    kind: "composite",
    targets: [
      { id: "aws-api", provider: "aws", engine: "cloudformation", entry: "a.yaml" },
      { id: "gcp-worker", provider: "gcp", engine: "infra-manager", entry: "b" },
    ],
  };

  it("should identify a composite descriptor and reject single / mislabeled kinds", () => {
    expect(isCompositeRuntime(COMPOSITE)).toBe(true);
    expect(isCompositeRuntime(AWS)).toBe(false);
    // "kind" present but not "composite" → not a composite (right side of the &&).
    expect(isCompositeRuntime({ kind: "bundle" } as unknown as ProblemRuntimeDescriptor)).toBe(
      false,
    );
  });

  it("should treat single descriptors as single and composite as not single", () => {
    expect(isSingleRuntime(AWS)).toBe(true);
    expect(isSingleRuntime(COMPOSITE)).toBe(false);
  });

  it("should classify a composite descriptor as composite", () => {
    expect(classifyRuntimeSupport(COMPOSITE)).toBe("composite");
  });

  it("should not treat a composite descriptor as executable or reserved", () => {
    expect(isExecutableRuntime(COMPOSITE)).toBe(false);
    expect(isReservedRuntime(COMPOSITE)).toBe(false);
  });
});

describe("isExecutableRuntime", () => {
  it("should be true only for aws/cloudformation", () => {
    expect(isExecutableRuntime(AWS)).toBe(true);
    expect(isExecutableRuntime({ provider: "aws", engine: "cdk", entry: "cdk.json" })).toBe(false);
    expect(isExecutableRuntime({ provider: "azure", engine: "bicep", entry: "x" })).toBe(false);
  });
});

describe("isReservedRuntime", () => {
  for (const { provider, engine } of RESERVED_RUNTIMES) {
    it(`should be true for the reserved pair ${provider}/${engine}`, () => {
      expect(isReservedRuntime({ provider, engine, entry: "x" })).toBe(true);
    });
  }

  it("should be false for executable and unknown runtimes", () => {
    expect(isReservedRuntime(AWS)).toBe(false);
    expect(isReservedRuntime({ provider: "kubernetes", engine: "helm", entry: "Chart.yaml" })).toBe(
      false,
    );
  });

  it("should be false for a reserved provider paired with a different engine", () => {
    expect(isReservedRuntime({ provider: "azure", engine: "arm-template", entry: "x" })).toBe(
      false,
    );
  });
});

describe("isContainerRuntime", () => {
  it("should be true for the local container pair docker/compose", () => {
    expect(isContainerRuntime(CONTAINER)).toBe(true);
  });

  it("should be false for executable, reserved, and unknown runtimes", () => {
    expect(isContainerRuntime(AWS)).toBe(false);
    expect(isContainerRuntime({ provider: "azure", engine: "bicep", entry: "x" })).toBe(false);
    expect(isContainerRuntime({ provider: "kubernetes", engine: "helm", entry: "x" })).toBe(false);
  });

  it("should be false for docker paired with a different engine", () => {
    expect(isContainerRuntime({ provider: "docker", engine: "swarm", entry: "x" })).toBe(false);
  });
});

describe("classifyRuntimeSupport", () => {
  it("should classify aws/cloudformation as executable", () => {
    expect(classifyRuntimeSupport(AWS)).toBe("executable");
  });

  for (const { provider, engine } of RESERVED_RUNTIMES) {
    it(`should classify the planned pair ${provider}/${engine} as reserved`, () => {
      expect(classifyRuntimeSupport({ provider, engine, entry: "x" })).toBe("reserved");
    });
  }

  it("should classify the local container runtime docker/compose as container", () => {
    expect(classifyRuntimeSupport(CONTAINER)).toBe("container");
  });

  it("should classify an unrecognized runtime as unknown", () => {
    expect(classifyRuntimeSupport({ provider: "kubernetes", engine: "helm", entry: "x" })).toBe(
      "unknown",
    );
  });
});
