import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../lib/app-config/index.js";
import { buildProblemDeployBackendBaseProps } from "../../lib/app-wiring/problem-deploy-backend-props.js";

/**
 * Issue #2209: SaaS (wire.ts) / Lite (bin/tenkacloud-lite.ts) が共有する
 * ProblemDeployBackendStack 共通 props factory の parity 検証。
 * 旧実装 (2 箇所の手コピー配線) と同じ shape を返し続けることを固定する。
 */

const fullBundle = {
  catalog: { p1: { title: "P1" } },
  scoring: { p1: { kind: "flag" } },
  writeups: { p1: { ja: "解説", en: "Explanation" } },
  endpoints: { p1: [{ name: "api" }] },
  phases: { p1: { phases: [] } },
  visibility: { p1: "public" },
  runtimes: { p1: { provider: "gcp" } },
  disruptions: { p1: [{ id: "d1" }] },
  coordination: { p1: { plugin: "x.ts" } },
  coordinationBundles: { p1: "bundled.mjs" },
  provenance: {
    p1: {
      source: "pack",
      packId: "com.example.cloud-pack",
      packVersion: "1.0.0",
      contentDigest: "sha256-abc",
    },
  },
} as const;

function stubConfig(problems: unknown): AppConfig {
  return {
    s3SourceBucket: "source-bucket",
    sourceZip: "source.zip",
    deployConcurrentBuildLimit: 2,
    environment: "development",
    problems,
  } as AppConfig;
}

describe("buildProblemDeployBackendBaseProps", () => {
  it("should map every shared field 1:1 when the catalog bundle is fully populated", () => {
    const props = buildProblemDeployBackendBaseProps(stubConfig(fullBundle));

    expect(props).toEqual({
      sourceBucketName: "source-bucket",
      sourceObjectKey: "source.zip",
      problemsCatalog: fullBundle.catalog,
      problemsScoring: fullBundle.scoring,
      problemsWriteups: fullBundle.writeups,
      problemsEndpoints: fullBundle.endpoints,
      problemsPhases: fullBundle.phases,
      problemsVisibility: fullBundle.visibility,
      problemRuntimes: fullBundle.runtimes,
      problemsDisruptions: fullBundle.disruptions,
      problemsProvenance: fullBundle.provenance,
      problemsCoordination: fullBundle.coordination,
      problemsCoordinationBundles: fullBundle.coordinationBundles,
      deployConcurrentBuildLimit: 2,
      deployAllowedCidrs: undefined,
      useBulkDistributedMap: undefined,
      deployViaLambda: undefined,
      packAssets: undefined,
      auditLogEnabled: undefined,
      controlDataBackend: undefined,
      tursoDatabaseUrl: undefined,
      tursoAuthTokenParameterName: undefined,
      opsMonitoring: undefined,
      environmentName: "development",
    });
  });

  it("should thread deployAllowedCidrs into the shared backend props", () => {
    const props = buildProblemDeployBackendBaseProps({
      ...stubConfig(fullBundle),
      deployAllowedCidrs: ["198.51.100.10/32", "203.0.113.0/24"],
    } as AppConfig);

    expect(props.deployAllowedCidrs).toEqual(["198.51.100.10/32", "203.0.113.0/24"]);
  });

  it("should fall back to empty objects for optional bundle keys missing from a stub source", () => {
    const props = buildProblemDeployBackendBaseProps(
      stubConfig({
        catalog: {},
        scoring: {},
        endpoints: {},
        // phases 以下の bundle keys は LocalCatalogSource なら常に存在するが、
        // テスト用 stub 注入時は欠けうる (= 旧 Lite 側の `?? {}` 防御の互換)。
      }),
    );

    expect(props.problemsPhases).toEqual({});
    expect(props.problemsWriteups).toEqual({});
    expect(props.problemsVisibility).toEqual({});
    expect(props.problemRuntimes).toEqual({});
    expect(props.problemsDisruptions).toEqual({});
    expect(props.problemsProvenance).toEqual({});
    expect(props.problemsCoordination).toEqual({});
    expect(props.problemsCoordinationBundles).toEqual({});
  });
});
