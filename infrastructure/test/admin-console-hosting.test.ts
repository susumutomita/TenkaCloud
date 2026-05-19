import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminConsoleHostingStack } from "../lib/admin-console-hosting";

/**
 * Issue #896: admin-console-hosting の CSP origin allow-list regression を検出する test。
 *
 * AdminConsoleHostingStack は dist/ を S3 deployment する。 ローカル / CI で未 build の場合は
 * placeholder を作って synth を通す (= application-admin-console-hosting.test.ts と同 pattern)。
 */
const distDir = path.join(__dirname, "..", "..", "apps", "admin-console", "dist");

function ensurePlaceholderDist(): void {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><html><body>placeholder</body></html>",
    );
  }
}

function synth(): Template {
  const app = new cdk.App();
  const stack = new AdminConsoleHostingStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    apiUrl: "https://api.example.com",
    cognitoDomain: "https://auth.example.amazoncognito.com",
    userClientId: "client-id",
    pooledApplicationAdminConsoleUrl: "https://pooled.example.cloudfront.net",
    provisioningCodeBuildProject: "proj",
    awsRegion: "ap-northeast-1",
    awsAccountId: "123456789012",
    adminInsightApiUrl: "https://insight.example.com",
    competitorBootstrapTemplateUrl:
      "https://tenkacloud-source.s3.ap-northeast-1.amazonaws.com/competitor-bootstrap.yaml",
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleHostingStack", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("CloudFront security headers (CSP) — Issue #896", () => {
    it("connect-src に adminInsightApiUrl を含むべき", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      expect(policy).toBeDefined();
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://insight.example.com");
    });

    it("connect-src に Control Plane apiUrl と cognitoDomain を含むべき", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://api.example.com");
      expect(cspJson).toContain("https://auth.example.amazoncognito.com");
    });

    it("form-action に Cognito domain を含むべき (= Hosted UI sign-in form)", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toMatch(/form-action[^;]*amazoncognito\.com/);
    });
  });
});
