import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { AdminConsoleRuntimeConfigStack } from "../lib/admin-console-runtime-config-stack";

/**
 * Issue #2192: AdminConsoleRuntimeConfigStack は Issue #867 の不変条件
 * 「runtime-config.json は絶対にキャッシュさせない (+ deploy 毎に CloudFront invalidation)」
 * の砦なのに専用テストが無かった。本番と同じ cross-stack ref 形状 (hosting stack の
 * Bucket / Distribution を別 stack から受ける) で synth し、BucketDeployment の
 * no-cache 配信契約と runtime-config.json の内容 (= synth アセットとして staging される)
 * を pin する。
 */

function synthRuntimeConfigStack() {
  // CDK_OUTDIR は worker 内で共有され他テストのアセットが残るため、 staged asset を
  // 誤読しないよう本 fixture 専用の outdir を切る (worker outdir 配下 = run 間で purge される)。
  const outdirBase = process.env.CDK_OUTDIR ?? tmpdir();
  mkdirSync(outdirBase, { recursive: true });
  const outdir = mkdtempSync(join(outdirBase, "runtime-config-test-"));
  const app = new App({ autoSynth: false, outdir });
  const hosting = new Stack(app, "HostingFixture");
  const siteBucket = new Bucket(hosting, "SiteBucket");
  const distribution = new Distribution(hosting, "Distribution", {
    defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(siteBucket) },
  });
  const stack = new AdminConsoleRuntimeConfigStack(app, "tenkacloud-admin-console-runtime-config", {
    siteBucket,
    distribution,
    apiUrl: "https://api.example.com/",
    cognitoDomain: "https://auth.example.com",
    userClientId: "client-123",
    pooledApplicationAdminConsoleUrl: "https://console.example.com",
    provisioningCodeBuildProject: "provisioning-project",
    awsRegion: "ap-northeast-1",
    awsAccountId: "123456789012",
    adminInsightApiUrl: "https://insight.example.com/",
    competitorBootstrapTemplateUrl: "https://bootstrap.example.com/template.yaml",
    cloudWatchDashboardName: "tenkacloud-dashboard",
    samlIdpDirectory: { "example.com": ["ExampleIdP"] },
  });
  const assembly = app.synth();
  return { template: Template.fromStack(stack), assemblyDir: assembly.directory };
}

/** synth アセット (Source.jsonData) として staging された runtime-config.json を読む。 */
function readStagedRuntimeConfig(assemblyDir: string): Record<string, unknown> {
  const assetDirs = readdirSync(assemblyDir).filter((name) => name.startsWith("asset."));
  for (const dir of assetDirs) {
    const files = readdirSync(join(assemblyDir, dir));
    if (files.includes("runtime-config.json")) {
      return JSON.parse(readFileSync(join(assemblyDir, dir, "runtime-config.json"), "utf8"));
    }
  }
  throw new Error(`runtime-config.json asset not found under ${assemblyDir}`);
}

describe("AdminConsoleRuntimeConfigStack (issue #867 no-cache invariant)", () => {
  const { template, assemblyDir } = synthRuntimeConfigStack();

  it("should deploy runtime-config.json with no-store/no-cache/must-revalidate and invalidate it", () => {
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SystemMetadata: { "cache-control": "no-store, no-cache, must-revalidate" },
      DistributionPaths: ["/runtime-config.json"],
      Prune: false,
    });
  });

  it("should bake the runtime config values (trailing slashes stripped) into the deployed JSON", () => {
    const runtimeConfig = readStagedRuntimeConfig(assemblyDir);
    expect(runtimeConfig).toEqual({
      apiUrl: "https://api.example.com",
      cognitoDomain: "https://auth.example.com",
      userClientId: "client-123",
      pooledApplicationAdminConsoleUrl: "https://console.example.com",
      provisioningCodeBuildProject: "provisioning-project",
      awsRegion: "ap-northeast-1",
      awsAccountId: "123456789012",
      adminInsightApiUrl: "https://insight.example.com",
      competitorBootstrapTemplateUrl: "https://bootstrap.example.com/template.yaml",
      cloudWatchDashboardName: "tenkacloud-dashboard",
      samlIdpDirectory: { "example.com": ["ExampleIdP"] },
    });
  });

  it("should contain exactly one BucketDeployment (runtime-config only, no site assets)", () => {
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
    expect(template.findResources("AWS::S3::Bucket")).toEqual({});
  });

  it("should keep the RuntimeConfigDeployment logical ID prefix stable (issue #1031 contract)", () => {
    const deployments = Object.keys(template.findResources("Custom::CDKBucketDeployment"));
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toMatch(/^RuntimeConfigDeployment/);
  });
});
