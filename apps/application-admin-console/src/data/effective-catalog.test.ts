/**
 * [Problem Packs / Issue #2093] Tests for the console-side EFFECTIVE catalog
 * projection. Pins three things that protect the compatibility contract:
 *   1. a core-only input is byte-identical to the legacy core projection (no pack
 *      provenance fields leak onto core problems);
 *   2. a pack problem carries the OPTIONAL `source` / `packId` / `packVersion` /
 *      `license` provenance, and a core problem never does;
 *   3. cost estimation is guarded to AWS/CloudFormation runtimes only — a non-AWS
 *      artifact is never handed to the CloudFormation cost analyzer.
 * Conflict semantics (packs cannot override core, duplicate ids fail closed)
 * mirror the backend composer's contract and are asserted to surface loudly here.
 */

import { describe, expect, it } from "vitest";
import {
  buildEffectiveCatalog,
  type CoreCatalogInput,
  type PackCatalogProblemInput,
} from "./effective-catalog";
import { metadataToDetail, type ProblemMetadata } from "./problems";

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
    tags: ["tag-a"],
    exposedPorts: [{ port: 8080, name: "http" }],
    learningGoals: ["goal-1"],
    cfnTemplate: "template.yaml",
    ...over,
  };
}

const AWS_TEMPLATE = `
Resources:
  Bucket:
    Type: AWS::S3::Bucket
`;

const NON_AWS_TEMPLATE = `
resources:
  - type: compute.v1.instance
    name: vm
`;

function core(over: Partial<ProblemMetadata> = {}, templateYaml?: string): CoreCatalogInput {
  return { metadata: metadata(over), templateYaml };
}

function pack(
  over: Partial<ProblemMetadata>,
  packFields: { packId: string; packVersion: string; license: string },
  templateYaml?: string,
): PackCatalogProblemInput {
  return { metadata: metadata(over), templateYaml, ...packFields };
}

describe("buildEffectiveCatalog (#2093 console effective catalog)", () => {
  it("should be byte-identical to the legacy core projection for a core-only input", () => {
    const legacy = [
      metadataToDetail(metadata({ id: "a" }), AWS_TEMPLATE),
      metadataToDetail(metadata({ id: "b" }), undefined),
    ].sort((x, y) => x.id.localeCompare(y.id));

    const effective = buildEffectiveCatalog({
      core: [core({ id: "a" }, AWS_TEMPLATE), core({ id: "b" })],
      packs: [],
    });

    expect(effective).toEqual(legacy);
  });

  it("should leave every core problem without pack provenance fields", () => {
    const [detail] = buildEffectiveCatalog({ core: [core({ id: "a" })], packs: [] });
    expect(detail.source).toBeUndefined();
    expect(detail.packId).toBeUndefined();
    expect(detail.packVersion).toBeUndefined();
    expect(detail.license).toBeUndefined();
  });

  it("should attach pack provenance only to problems that come from a pack", () => {
    const catalog = buildEffectiveCatalog({
      core: [core({ id: "core-x" })],
      packs: [
        pack(
          { id: "pack-y", name: "Pack Y" },
          { packId: "com.example.pack", packVersion: "1.2.0", license: "Apache-2.0" },
        ),
      ],
    });

    const coreEntry = catalog.find((p) => p.id === "core-x");
    const packEntry = catalog.find((p) => p.id === "pack-y");
    expect(coreEntry?.source).toBeUndefined();
    expect(packEntry).toMatchObject({
      source: "pack",
      packId: "com.example.pack",
      packVersion: "1.2.0",
      license: "Apache-2.0",
    });
  });

  it("should estimate cost for an AWS/CloudFormation pack problem", () => {
    const [detail] = buildEffectiveCatalog({
      core: [],
      packs: [
        pack(
          { id: "aws-p" },
          { packId: "com.example.pack", packVersion: "1.0.0", license: "MIT" },
          AWS_TEMPLATE,
        ),
      ],
    });
    expect(detail.costEstimate).toBeDefined();
    expect(detail.costEstimate?.resourceTypes).toContain("AWS::S3::Bucket");
  });

  it("should NOT estimate cost for a non-AWS runtime even when a template is present", () => {
    const [detail] = buildEffectiveCatalog({
      core: [
        core(
          { id: "gcp-p", runtime: { provider: "gcp", engine: "infra-manager" } },
          NON_AWS_TEMPLATE,
        ),
      ],
      packs: [],
    });
    expect(detail.costEstimate).toBeUndefined();
  });

  it("should fail closed when a pack id collides with a core id (no override)", () => {
    expect(() =>
      buildEffectiveCatalog({
        core: [core({ id: "dup" })],
        packs: [
          pack({ id: "dup" }, { packId: "com.example.pack", packVersion: "1.0.0", license: "MIT" }),
        ],
      }),
    ).toThrow(/DUPLICATE_PROBLEM_ID/);
  });

  it("should sort the effective catalog by id for a stable display order", () => {
    const catalog = buildEffectiveCatalog({
      core: [core({ id: "m" }), core({ id: "a" })],
      packs: [pack({ id: "z" }, { packId: "p", packVersion: "1.0.0", license: "MIT" })],
    });
    expect(catalog.map((p) => p.id)).toEqual(["a", "m", "z"]);
  });
});
