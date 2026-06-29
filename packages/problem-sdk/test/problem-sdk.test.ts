/**
 * [Problem SDK / Issue #2106] Contract tests for `@tenkacloud/problem-sdk`.
 *
 * Every test runs without AWS SDK / CDK / fetch / env / clock — the SDK is a pure
 * authoring contract.
 */

import { describe, expect, it } from "vitest";
import {
  formatDiagnostics,
  PACK_SCHEMA_VERSION,
  type ProblemRuntimeDescriptor,
  SUPPORTED_RUNTIME_CAPABILITIES,
  type ValidationDiagnostic,
  validatePackManifest,
  validateProblemMetadata,
} from "../src/index.js";
import {
  INVALID_MANIFEST,
  INVALID_METADATA_BAD_RUNTIME,
  INVALID_METADATA_BAD_SCORING,
  INVALID_METADATA_NO_ID,
  INVALID_METADATA_UNKNOWN_CAPABILITY,
  VALID_COMPOSITE_METADATA,
  VALID_MANIFEST,
  VALID_METADATA,
} from "./fixtures.js";

describe("@tenkacloud/problem-sdk public contract", () => {
  it("should expose the frozen schema version constant", () => {
    expect(PACK_SCHEMA_VERSION).toBe(1);
  });

  it("should accept valid metadata fixtures", () => {
    expect(validateProblemMetadata(VALID_METADATA)).toEqual([]);
    expect(validateProblemMetadata(VALID_COMPOSITE_METADATA)).toEqual([]);
  });

  it("should reject invalid metadata fixtures", () => {
    expect(validateProblemMetadata(INVALID_METADATA_NO_ID).length).toBeGreaterThan(0);
    expect(validateProblemMetadata(INVALID_METADATA_BAD_SCORING).length).toBeGreaterThan(0);
    expect(validateProblemMetadata(INVALID_METADATA_BAD_RUNTIME).length).toBeGreaterThan(0);
  });

  it("should accept a valid manifest and reject an invalid one", () => {
    expect(validatePackManifest(VALID_MANIFEST)).toEqual([]);
    expect(validatePackManifest(INVALID_MANIFEST).length).toBeGreaterThan(0);
  });
});

describe("validateProblemMetadata diagnostics", () => {
  it("should return stable namespaced diagnostic codes", () => {
    const noId = validateProblemMetadata(INVALID_METADATA_NO_ID);
    expect(noId.some((d) => d.code === "PROBLEM_METADATA_INVALID")).toBe(true);

    const badScoring = validateProblemMetadata(INVALID_METADATA_BAD_SCORING);
    expect(badScoring.some((d) => d.code === "PROBLEM_METADATA_INVALID")).toBe(true);

    // Every code is namespaced PACK_* / PROBLEM_* / RUNTIME_* / SCORING_*.
    const allCodes = [
      ...noId,
      ...badScoring,
      ...validateProblemMetadata(INVALID_METADATA_UNKNOWN_CAPABILITY),
      ...validatePackManifest(INVALID_MANIFEST),
    ].map((d) => d.code);
    for (const code of allCodes) {
      expect(code).toMatch(/^(PACK|PROBLEM|RUNTIME|SCORING)_/);
    }
  });

  it("should reject unknown runtime capability", () => {
    const diagnostics = validateProblemMetadata(INVALID_METADATA_UNKNOWN_CAPABILITY);
    expect(diagnostics.some((d) => d.code === "RUNTIME_MISMATCH")).toBe(true);
  });

  it("should carry code, path, and message on every diagnostic", () => {
    for (const diagnostic of validateProblemMetadata(INVALID_METADATA_NO_ID)) {
      expect(typeof diagnostic.code).toBe("string");
      expect(typeof diagnostic.path).toBe("string");
      expect(typeof diagnostic.message).toBe("string");
    }
  });
});

describe("determinism", () => {
  it("should not read process env or clock (same input → same output)", () => {
    const a = validateProblemMetadata(INVALID_METADATA_BAD_SCORING);
    process.env.TENKACLOUD_SDK_TEST_FLAG = "mutated";
    const b = validateProblemMetadata(INVALID_METADATA_BAD_SCORING);
    delete process.env.TENKACLOUD_SDK_TEST_FLAG;
    expect(b).toEqual(a);

    const m1 = validatePackManifest(INVALID_MANIFEST);
    const m2 = validatePackManifest(INVALID_MANIFEST);
    expect(m2).toEqual(m1);
  });

  it("should render diagnostics deterministically", () => {
    const diagnostics = validatePackManifest(INVALID_MANIFEST);
    expect(formatDiagnostics(diagnostics)).toBe(formatDiagnostics(diagnostics));
    expect(formatDiagnostics([])).toBe("");
  });

  it("should render an optional hint when present", () => {
    const withHint: ValidationDiagnostic = {
      code: "PROBLEM_METADATA_INVALID",
      path: "metadata.json:id",
      message: "missing id",
      hint: "add a non-empty string id",
    };
    expect(formatDiagnostics([withHint])).toContain("hint: add a non-empty string id");
  });
});

describe("runtime capabilities", () => {
  it("should serialize every exported runtime descriptor", () => {
    const single: ProblemRuntimeDescriptor = {
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    };
    const composite: ProblemRuntimeDescriptor = {
      kind: "composite",
      targets: [{ id: "a", provider: "aws", engine: "cloudformation", entry: "template.yaml" }],
    };
    for (const descriptor of [single, composite]) {
      const roundTripped = JSON.parse(JSON.stringify(descriptor));
      expect(roundTripped).toEqual(descriptor);
    }
  });

  it("should expose a stable-sorted, deduplicated supported capability set", () => {
    const keys = SUPPORTED_RUNTIME_CAPABILITIES.map((c) => `${c.provider}/${c.engine}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("aws/cloudformation");
  });
});
