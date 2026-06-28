import { describe, expect, it } from "vitest";
import {
  classifyRuntimeSupport,
  DEFAULT_ENTRY,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isExecutableRuntime,
  isReservedRuntime,
  normalizeRuntime,
  RESERVED_RUNTIMES,
  type RuntimeDescriptor,
  RuntimeValidationError,
} from "../src/index.js";

const AWS: RuntimeDescriptor = {
  provider: "aws",
  engine: "cloudformation",
  entry: "template.yaml",
};

describe("constants", () => {
  it("should pin the single executable provider/engine and default entry", () => {
    expect(EXECUTABLE_PROVIDER).toBe("aws");
    expect(EXECUTABLE_ENGINE).toBe("cloudformation");
    expect(DEFAULT_ENTRY).toBe("template.yaml");
  });

  it("should reserve exactly the three ADR-026/027 roadmap pairs in order", () => {
    expect(RESERVED_RUNTIMES).toEqual([
      { provider: "sakura", engine: "apprun" },
      { provider: "azure", engine: "bicep" },
      { provider: "gcp", engine: "infra-manager" },
    ]);
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

describe("classifyRuntimeSupport", () => {
  it("should classify aws/cloudformation as executable", () => {
    expect(classifyRuntimeSupport(AWS)).toBe("executable");
  });

  for (const { provider, engine } of RESERVED_RUNTIMES) {
    it(`should classify the planned pair ${provider}/${engine} as reserved`, () => {
      expect(classifyRuntimeSupport({ provider, engine, entry: "x" })).toBe("reserved");
    });
  }

  it("should classify an unrecognized runtime as unknown", () => {
    expect(classifyRuntimeSupport({ provider: "kubernetes", engine: "helm", entry: "x" })).toBe(
      "unknown",
    );
  });
});
