import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { AdminConsoleRuntimeConfigStack } from "../lib/admin-console-runtime-config-stack";

/**
 * Issue #2192: AdminConsoleRuntimeConfigStack の synth regression 網。
 *
 * 本 stack は Issue #867 の「runtime-config.json は絶対にキャッシュさせない + deploy 毎に
 * CloudFront invalidation」という不変条件の砦だが、専用テストが無かった。 no-cache ヘッダ /
 * invalidation path / prune 無効を CFn レベルで pin する。
 */
const ENV = { env: { account: "123456789012", region: "ap-northeast-1" } };

function synthRuntimeConfigStack(): Template {
  const app = new cdk.App({ autoSynth: false });
  // cross-stack ref の供給元 (= 実構成では AdminConsoleHostingStack)。 dist/ asset を焼く本物の
  // hosting stack を使うと SPA build 成果物に依存するため、最小の Bucket + Distribution で代替する。
  const sourceStack = new cdk.Stack(app, "SourceStack", ENV);
  const siteBucket = new Bucket(sourceStack, "SiteBucket");
  const distribution = new Distribution(sourceStack, "Distribution", {
    defaultBehavior: { origin: new HttpOrigin("example.com") },
  });

  const stack = new AdminConsoleRuntimeConfigStack(app, "RuntimeConfigStack", {
    ...ENV,
    siteBucket,
    distribution,
    apiUrl: "https://api.example.com/",
    cognitoDomain: "https://auth.example.com",
    userClientId: "client-123",
    pooledApplicationAdminConsoleUrl: "https://tenant.example.com",
    provisioningCodeBuildProject: "provisioning-project",
    awsRegion: "ap-northeast-1",
    awsAccountId: "123456789012",
    adminInsightApiUrl: "https://insight.example.com/",
    competitorBootstrapTemplateUrl: "https://bootstrap.example.com/template.yaml",
    cloudWatchDashboardName: "tenkacloud-dashboard",
    samlIdpDirectory: {},
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleRuntimeConfigStack", () => {
  it("should deploy runtime-config.json exactly once via a BucketDeployment", () => {
    const template = synthRuntimeConfigStack();
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
  });

  it("should forbid caching of runtime-config.json (#867)", () => {
    const template = synthRuntimeConfigStack();
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SystemMetadata: { "cache-control": "no-store, no-cache, must-revalidate" },
    });
  });

  it("should invalidate /runtime-config.json on every deploy without pruning the site", () => {
    const template = synthRuntimeConfigStack();
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/runtime-config.json"],
      Prune: false,
    });
  });

  it("should keep the deployment scoped to the runtime-config source object only", () => {
    const template = synthRuntimeConfigStack();
    // Source.jsonData 1 件のみ (= SPA 本体の SiteDeployment を巻き込まない)。
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    const [resource] = Object.values(deployments);
    expect(resource?.Properties?.SourceObjectKeys).toHaveLength(1);
  });
});
