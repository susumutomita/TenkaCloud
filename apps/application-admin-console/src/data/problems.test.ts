/**
 * [Problem Packs / Issue #2086] Characterization tests for the application admin
 * console's local build-time catalog projection. Pins the current behavior of the
 * pure transforms that turn a `metadata.json` shape into the catalog's
 * `ProblemDetail` / runtime-gating / provider-label views, before pack support is
 * added. No production behavior is changed.
 *
 * Only the pure functions are exercised (no `import.meta.glob` content is
 * asserted), so the characterization is deterministic and independent of which
 * problems happen to be checked out in the `problems/` submodule.
 */

import { describe, expect, it } from "vitest";
import {
  isExecutableProblemRuntime,
  metadataToDetail,
  PROVIDER_LABEL,
  type ProblemMetadata,
} from "./problems";

function metadata(over: Partial<ProblemMetadata> = {}): ProblemMetadata {
  return {
    id: "sample-problem",
    name: "Sample Problem",
    category: "Challenge",
    status: "ready",
    difficulty: 3,
    estimatedDuration: "30m",
    shortDescription: "short",
    description: "long description",
    tags: ["tag-a", "tag-b"],
    exposedPorts: [{ port: 8080, name: "http" }],
    learningGoals: ["goal-1"],
    cfnTemplate: "template.yaml",
    ...over,
  };
}

describe("metadataToDetail (#2086 build-time catalog projection)", () => {
  it("should map core metadata fields into a ProblemDetail", () => {
    const detail = metadataToDetail(metadata());
    expect(detail).toMatchObject({
      id: "sample-problem",
      name: "Sample Problem",
      category: "Challenge",
      status: "ready",
      difficulty: 3,
      estimatedDuration: "30m",
      shortDescription: "short",
      description: "long description",
      tags: ["tag-a", "tag-b"],
      exposedPorts: [{ port: 8080, name: "http" }],
      learningGoals: ["goal-1"],
    });
  });

  it("should default the runtime to aws/cloudformation when none is declared", () => {
    expect(metadataToDetail(metadata()).runtime).toEqual({
      provider: "aws",
      engine: "cloudformation",
    });
  });

  it("should project a declared multi-cloud runtime", () => {
    const detail = metadataToDetail(
      metadata({ runtime: { provider: "gcp", engine: "infra-manager" } }),
    );
    expect(detail.runtime).toEqual({ provider: "gcp", engine: "infra-manager" });
  });

  it("should include optional region and scoring facets only when declared", () => {
    const withFacets = metadataToDetail(
      metadata({
        defaultRegion: "ap-northeast-1",
        supportedRegions: ["ap-northeast-1", "us-east-1"],
        scoring: { kind: "flag" },
      }),
    );
    expect(withFacets.defaultRegion).toBe("ap-northeast-1");
    expect(withFacets.supportedRegions).toEqual(["ap-northeast-1", "us-east-1"]);
    expect(withFacets.scoringKind).toBe("flag");

    const withoutFacets = metadataToDetail(metadata());
    expect(withoutFacets.defaultRegion).toBeUndefined();
    expect(withoutFacets.supportedRegions).toBeUndefined();
    expect(withoutFacets.scoringKind).toBeUndefined();
  });

  it("should omit an empty supportedRegions array", () => {
    expect(metadataToDetail(metadata({ supportedRegions: [] })).supportedRegions).toBeUndefined();
  });

  it("should omit costEstimate when no template YAML is provided", () => {
    expect(metadataToDetail(metadata()).costEstimate).toBeUndefined();
  });
});

describe("isExecutableProblemRuntime (#2086)", () => {
  it("should treat only aws/cloudformation as executable", () => {
    expect(isExecutableProblemRuntime({ provider: "aws", engine: "cloudformation" })).toBe(true);
  });

  it("should treat reserved provider/engine pairs as not executable", () => {
    expect(isExecutableProblemRuntime({ provider: "gcp", engine: "infra-manager" })).toBe(false);
    expect(isExecutableProblemRuntime({ provider: "azure", engine: "bicep" })).toBe(false);
    expect(isExecutableProblemRuntime({ provider: "sakura", engine: "apprun" })).toBe(false);
    expect(isExecutableProblemRuntime({ provider: "aws", engine: "cdk" })).toBe(false);
  });
});

describe("PROVIDER_LABEL (#2086)", () => {
  it("should map the four known providers to brand labels", () => {
    expect(PROVIDER_LABEL.aws).toBe("AWS");
    expect(PROVIDER_LABEL.gcp).toBe("Google Cloud");
    expect(PROVIDER_LABEL.azure).toBe("Azure");
    expect(PROVIDER_LABEL.sakura).toBe("Sakura Cloud");
  });

  it("should leave an unknown provider unlabeled (caller falls back to the raw value)", () => {
    expect(PROVIDER_LABEL.oracle).toBeUndefined();
  });
});
