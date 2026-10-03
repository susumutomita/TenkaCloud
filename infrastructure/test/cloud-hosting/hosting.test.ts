import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { afterAll, describe, expect, it } from "vitest";
import { buildSpaHosting, deployRuntimeConfigJson } from "../../lib/hosting/spa-hosting.js";
import { buildSecurityHeadersPolicy } from "../../lib/security/cloudfront-headers.js";

const directory = mkdtempSync(join(tmpdir(), "tenkacloud-hosting-rollback-"));
const assets = join(directory, "assets");
mkdirSync(assets);
writeFileSync(join(assets, "index.html"), "<!doctype html><title>Hosting test</title>");
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function hostingTemplate() {
  const app = new App({ outdir: join(directory, "cdk.out"), autoSynth: false });
  const stack = new Stack(app, "Hosting", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const scope = new Construct(stack, "ApplicationAdminConsoleHosting");
  const hosting = buildSpaHosting(scope, {
    distDir: assets,
    securityHeaders: buildSecurityHeadersPolicy(scope, "SecurityHeaders"),
  });
  deployRuntimeConfigJson(scope, hosting, {
    apiUrl: "https://synthetic.execute-api.us-east-1.amazonaws.com/prod",
  });
  return Template.fromStack(stack);
}

describe("restored owned hosting bucket rollback", () => {
  it("arms cleanup before both SPA and runtime-config uploads and tears uploads down first", () => {
    const template = hostingTemplate();
    const [cleanupId, cleanup] =
      Object.entries(template.findResources("Custom::S3AutoDeleteObjects"))[0] ?? [];
    const [policyId] = Object.keys(template.findResources("AWS::S3::BucketPolicy"));
    const deployments = Object.values(template.findResources("Custom::CDKBucketDeployment"));
    expect(deployments).toHaveLength(2);
    expect(cleanupId).toBeDefined();
    expect(policyId).toBeDefined();
    expect(cleanup?.DependsOn).toContain(policyId);
    for (const deployment of deployments) {
      expect(deployment.DependsOn).toContain(cleanupId);
      expect(deployment.DependsOn).toContain(policyId);
      expect(deployment.Properties).toMatchObject({ RetainOnDelete: false, Prune: false });
    }
  });

  it("retains original bucket IDs, whole-bucket cleanup and Delete policies", () => {
    const template = hostingTemplate();
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets)).toHaveLength(1);
    expect(Object.keys(buckets)[0]).toMatch(/^ApplicationAdminConsoleHostingSiteBucket/u);
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.DeletionPolicy).toBe("Delete");
      expect(bucket.UpdateReplacePolicy).toBe("Delete");
    }
  });
});
