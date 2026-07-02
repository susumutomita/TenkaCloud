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
  endpoints: { p1: [{ name: "api" }] },
  phases: { p1: { phases: [] } },
  visibility: { p1: "public" },
  runtimes: { p1: { provider: "gcp" } },
  disruptions: { p1: [{ id: "d1" }] },
  coordination: { p1: { plugin: "x.ts" } },
  coordinationBundles: { p1: "bundled.mjs" },
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
      problemsEndpoints: fullBundle.endpoints,
      problemsPhases: fullBundle.phases,
      problemsVisibility: fullBundle.visibility,
      problemRuntimes: fullBundle.runtimes,
      problemsDisruptions: fullBundle.disruptions,
      problemsCoordination: fullBundle.coordination,
      problemsCoordinationBundles: fullBundle.coordinationBundles,
      deployConcurrentBuildLimit: 2,
      environmentName: "development",
    });
  });

  it("should fall back to empty objects for optional bundle keys missing from a stub source", () => {
    const props = buildProblemDeployBackendBaseProps(
      stubConfig({
        catalog: {},
        scoring: {},
        endpoints: {},
        // phases 以下の 6 キーは LocalCatalogSource なら常に存在するが、
        // テスト用 stub 注入時は欠けうる (= 旧 Lite 側の `?? {}` 防御の互換)。
      }),
    );

    expect(props.problemsPhases).toEqual({});
    expect(props.problemsVisibility).toEqual({});
    expect(props.problemRuntimes).toEqual({});
    expect(props.problemsDisruptions).toEqual({});
    expect(props.problemsCoordination).toEqual({});
    expect(props.problemsCoordinationBundles).toEqual({});
  });
});
