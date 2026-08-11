import { describe, expect, it } from "vitest";
import {
  findProblem,
  isExecutableProblemRuntime,
  listProblemSummaries,
  metadataToDetail,
  PROBLEM_CATALOG,
  type ProblemCostEstimateSummary,
  type ProblemMetadata,
} from "../../src/data/problems";

/**
 * Tenant Admin Console の build-time problem catalog。 metadataToDetail の region 系
 * optional field 分岐 (= defaultRegion / supportedRegions の有無) と、 findProblem の
 * hit/miss、 listProblemSummaries の projection を pin する。 cfnTemplate 等の deploy 内部
 * field を ProblemDetail に漏らさない契約も確認する。
 */
const BASE_METADATA: ProblemMetadata = {
  id: "sample-problem",
  name: "Sample Problem",
  category: "Challenge",
  status: "ready",
  difficulty: 3,
  estimatedDuration: "30m",
  shortDescription: "short",
  description: "long description",
  tags: ["aws", "s3"],
  exposedPorts: [{ port: 8080, name: "app" }],
  learningGoals: ["learn s3"],
  cfnTemplate: "AWSTemplateFormatVersion...",
  cfnParameters: { Foo: "Bar" },
};

const TEMPLATE_WITH_ALWAYS_ON_COST = `Resources:
  Cache:
    Type: AWS::ElastiCache::CacheCluster
  QueueLog:
    Type: AWS::Logs::LogGroup
`;

describe("metadataToDetail", () => {
  it("should include defaultRegion + non-empty supportedRegions and drop deploy internals", () => {
    const detail = metadataToDetail({
      ...BASE_METADATA,
      defaultRegion: "ap-northeast-1",
      supportedRegions: ["ap-northeast-1", "us-east-1"],
    });
    expect(detail.defaultRegion).toBe("ap-northeast-1");
    expect(detail.supportedRegions).toEqual(["ap-northeast-1", "us-east-1"]);
    // cfnTemplate / cfnParameters は ProblemDetail に map しない (= UI に deploy 内部を出さない)。
    const json = JSON.stringify(detail);
    expect(json).not.toContain("cfnTemplate");
    expect(json).not.toContain("cfnParameters");
  });

  it("should omit defaultRegion / supportedRegions when they are absent", () => {
    const detail = metadataToDetail(BASE_METADATA);
    expect(detail.defaultRegion).toBeUndefined();
    expect(detail.supportedRegions).toBeUndefined();
  });

  it("should omit supportedRegions when the array is present but empty", () => {
    const detail = metadataToDetail({ ...BASE_METADATA, supportedRegions: [] });
    expect(detail.supportedRegions).toBeUndefined();
  });

  it("should default the runtime to aws/cloudformation when none is declared", () => {
    expect(metadataToDetail(BASE_METADATA).runtime).toEqual({
      provider: "aws",
      engine: "cloudformation",
    });
  });

  it("should project a declared multi-cloud runtime", () => {
    const detail = metadataToDetail({
      ...BASE_METADATA,
      runtime: { provider: "gcp", engine: "infra-manager", entry: "main.tf" },
    });
    expect(detail.runtime).toEqual({ provider: "gcp", engine: "infra-manager" });
  });

  it("should preserve every target of a composite runtime", () => {
    const detail = metadataToDetail({
      ...BASE_METADATA,
      runtime: {
        kind: "composite",
        targets: [
          { id: "aws", provider: "aws", engine: "cloudformation", entry: "template.yaml" },
          { id: "gcp", provider: "gcp", engine: "infra-manager", entry: "gcp/main.tf" },
        ],
      },
    });

    expect(detail.runtime).toEqual({
      kind: "composite",
      targets: [
        { id: "aws", provider: "aws", engine: "cloudformation" },
        { id: "gcp", provider: "gcp", engine: "infra-manager" },
      ],
    });
  });

  it("should project scoring.kind to scoringKind (Issue #1776)", () => {
    const detail = metadataToDetail({ ...BASE_METADATA, scoring: { kind: "flag" } });
    expect(detail.scoringKind).toBe("flag");
  });

  it("should omit scoringKind when scoring is not declared (= deploy-only problem)", () => {
    expect(metadataToDetail(BASE_METADATA).scoringKind).toBeUndefined();
  });

  it("should derive a cost estimate from the CloudFormation template when available", () => {
    const detail = metadataToDetail(BASE_METADATA, TEMPLATE_WITH_ALWAYS_ON_COST);
    expect(detail.costEstimate).toMatchObject({
      totalHourlyUsd: 0.018,
      perSessionUsd: 0.009,
      resourceTypes: ["AWS::ElastiCache::CacheCluster", "AWS::Logs::LogGroup"],
    } satisfies Partial<ProblemCostEstimateSummary>);
    expect(detail.costEstimate?.perDayIfLeftRunningUsd).toBeCloseTo(0.432, 5);
    expect(detail.costEstimate?.alwaysOnResources.map((r) => r.logicalId)).toEqual(["Cache"]);
  });
});

describe("isExecutableProblemRuntime", () => {
  it("should be true only for aws/cloudformation", () => {
    expect(isExecutableProblemRuntime({ provider: "aws", engine: "cloudformation" })).toBe(true);
  });

  it.each([
    { provider: "sakura", engine: "apprun" },
    { provider: "azure", engine: "bicep" },
    { provider: "gcp", engine: "infra-manager" },
    { provider: "aws", engine: "cdk" }, // 同 provider でも非 CFn engine は不可
  ])("should be false for the reserved / non-CFn runtime $provider/$engine", (rt) => {
    expect(isExecutableProblemRuntime(rt)).toBe(false);
  });
});

describe("findProblem", () => {
  it("should return a detail for an id in the catalog", () => {
    const first = PROBLEM_CATALOG[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(findProblem(first.id)?.id).toBe(first.id);
  });

  it("should return undefined for an unknown id", () => {
    expect(findProblem("does-not-exist-zzz")).toBeUndefined();
  });
});

describe("listProblemSummaries", () => {
  it("should project each catalog entry to the summary shape without deploy internals", () => {
    const summaries = listProblemSummaries();
    expect(summaries.length).toBe(PROBLEM_CATALOG.length);
    for (const s of summaries) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(JSON.stringify(s)).not.toContain("cfnTemplate");
      // description (= 長文) は summary には含めない。
      expect((s as unknown as { description?: string }).description).toBeUndefined();
    }
  });

  it("should be sorted by id (ascending, locale-aware)", () => {
    const ids = listProblemSummaries().map((s) => s.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });

  it("should carry the catalog entry's scoringKind through to the summary (Issue #1776)", () => {
    for (const s of listProblemSummaries()) {
      expect(s.scoringKind).toBe(findProblem(s.id)?.scoringKind);
    }
  });

  it("should carry each catalog entry's derived cost estimate through to the summary", () => {
    for (const s of listProblemSummaries()) {
      expect(s.costEstimate).toBe(findProblem(s.id)?.costEstimate);
    }
  });
});
