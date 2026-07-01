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
  buildCoreInputs,
  buildPackInputs,
  enabledNonAwsProviders,
  findPackManifest,
  isExecutableProblemRuntime,
  isLocalOnlyProblemRuntime,
  isProviderSelectable,
  metadataToDetail,
  NON_AWS_SELECTABLE_PROVIDERS,
  type PackManifestShape,
  PROVIDER_LABEL,
  type ProblemDetail,
  type ProblemMetadata,
  packProvenanceFields,
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

describe("isLocalOnlyProblemRuntime (#2168)", () => {
  it("should treat a docker/compose runtime as local-only", () => {
    expect(isLocalOnlyProblemRuntime({ provider: "docker", engine: "compose" })).toBe(true);
  });

  it("should not treat cloud (executable or reserved) runtimes as local-only", () => {
    expect(isLocalOnlyProblemRuntime({ provider: "aws", engine: "cloudformation" })).toBe(false);
    expect(isLocalOnlyProblemRuntime({ provider: "sakura", engine: "apprun" })).toBe(false);
    expect(isLocalOnlyProblemRuntime({ provider: "azure", engine: "bicep" })).toBe(false);
    expect(isLocalOnlyProblemRuntime({ provider: "gcp", engine: "infra-manager" })).toBe(false);
  });

  it("should not treat an unknown (typo) runtime as local-only", () => {
    expect(isLocalOnlyProblemRuntime({ provider: "docker", engine: "swarm" })).toBe(false);
    expect(isLocalOnlyProblemRuntime({ provider: "podman", engine: "compose" })).toBe(false);
  });
});

describe("NON_AWS_SELECTABLE_PROVIDERS / enabledNonAwsProviders (#2167)", () => {
  it("should list the non-AWS providers that have a working adapter", () => {
    expect([...NON_AWS_SELECTABLE_PROVIDERS].sort()).toEqual(["azure", "gcp", "sakura"]);
  });

  it("should enable every non-AWS provider when the flag is on", () => {
    const enabled = enabledNonAwsProviders(true);
    expect(enabled.has("sakura")).toBe(true);
    expect(enabled.has("azure")).toBe(true);
    expect(enabled.has("gcp")).toBe(true);
  });

  it("should enable no providers when the flag is off", () => {
    expect(enabledNonAwsProviders(false).size).toBe(0);
  });
});

describe("isProviderSelectable (#2167)", () => {
  it("should always allow aws/cloudformation regardless of enabled set", () => {
    expect(isProviderSelectable({ provider: "aws", engine: "cloudformation" }, new Set())).toBe(
      true,
    );
  });

  it("should allow a reserved runtime only when its provider is enabled", () => {
    const runtime = { provider: "sakura", engine: "apprun" };
    expect(isProviderSelectable(runtime, new Set())).toBe(false);
    expect(isProviderSelectable(runtime, new Set(["sakura"]))).toBe(true);
  });

  it("should reject an unknown engine even when the provider is enabled", () => {
    expect(isProviderSelectable({ provider: "gcp", engine: "cdktf" }, new Set(["gcp"]))).toBe(
      false,
    );
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

describe("buildCoreInputs (#2093 core glob projection)", () => {
  it("should pair each core metadata module with its sibling template body", () => {
    const inputs = buildCoreInputs(
      { "../../../../problems/challenges/a/metadata.json": { default: metadata({ id: "a" }) } },
      { "../../../../problems/challenges/a/template.yaml": "Resources: {}" },
    );
    expect(inputs).toEqual([{ metadata: metadata({ id: "a" }), templateYaml: "Resources: {}" }]);
  });
});

describe("findPackManifest (#2093 snapshot provenance lookup)", () => {
  const manifests = {
    "../../../../.tenkacloud/pack-store/snapshots/p/r/tenkacloud-pack.json": {
      default: { id: "com.example.pack", version: "1.2.3", license: "MIT" },
    },
  };

  it("should return the manifest whose directory prefixes the metadata path", () => {
    const found = findPackManifest(
      manifests,
      "../../../../.tenkacloud/pack-store/snapshots/p/r/challenges/x/metadata.json",
    );
    expect(found).toEqual({ id: "com.example.pack", version: "1.2.3", license: "MIT" });
  });

  it("should return undefined when no manifest directory prefixes the path", () => {
    expect(
      findPackManifest(manifests, "../../../../problems/challenges/core/metadata.json"),
    ).toBeUndefined();
  });
});

describe("buildPackInputs (#2093 pack-snapshot glob projection)", () => {
  const base = "../../../../.tenkacloud/pack-store/snapshots/com.example.pack/abc";
  const manifest: PackManifestShape = {
    id: "com.example.pack",
    version: "2.0.0",
    license: "Apache-2.0",
  };

  it("should attach pack provenance and template to a snapshot that has a manifest", () => {
    const inputs = buildPackInputs(
      { [`${base}/challenges/x/metadata.json`]: { default: metadata({ id: "x" }) } },
      { [`${base}/challenges/x/template.yaml`]: "Resources: {}" },
      { [`${base}/tenkacloud-pack.json`]: { default: manifest } },
    );
    expect(inputs).toEqual([
      {
        metadata: metadata({ id: "x" }),
        templateYaml: "Resources: {}",
        packId: "com.example.pack",
        packVersion: "2.0.0",
        license: "Apache-2.0",
      },
    ]);
  });

  it("should skip a snapshot whose manifest is missing rather than mislabel it as core", () => {
    const inputs = buildPackInputs(
      { [`${base}/challenges/x/metadata.json`]: { default: metadata({ id: "x" }) } },
      {},
      {},
    );
    expect(inputs).toEqual([]);
  });
});

describe("packProvenanceFields (#2093 sparse provenance projection)", () => {
  function detail(over: Partial<ProblemDetail> = {}): ProblemDetail {
    return { ...metadataToDetail(metadata()), ...over };
  }

  it("should return the provenance fields for a pack-sourced problem", () => {
    const fields = packProvenanceFields(
      detail({ source: "pack", packId: "com.example.pack", packVersion: "1.0.0", license: "MIT" }),
    );
    expect(fields).toEqual({
      source: "pack",
      packId: "com.example.pack",
      packVersion: "1.0.0",
      license: "MIT",
    });
  });

  it("should return no fields for a core problem", () => {
    expect(packProvenanceFields(detail())).toEqual({});
  });
});
