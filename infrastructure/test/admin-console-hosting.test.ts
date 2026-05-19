import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminConsoleHostingStack } from "../lib/admin-console-hosting";

/**
 * Issue #1031: admin-console-hosting は CloudFront + SiteBucket + dist/ deployment のみを担い、
 * runtime-config.json は `AdminConsoleRuntimeConfigStack` が別 stack で書く。 backend URL の
 * cross-stack ref を本 stack から切ったため、 CSP は region wildcard。
 *
 * 旧 Issue #896 の strict CSP 検査 (= execute-api / auth host 名 厳密 allow) は wildcard 化に伴い
 * pattern を緩めて pin する (= 同 region 内 API GW / Cognito domain だけは少なくとも許可される)。
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
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleHostingStack", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("CloudFront security headers (CSP wildcard, Issue #1031)", () => {
    it("connect-src に execute-api region wildcard を含むべき", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      expect(policy).toBeDefined();
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://*.execute-api.ap-northeast-1.amazonaws.com");
    });

    it("connect-src に Cognito domain wildcard を含むべき", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://*.amazoncognito.com");
      expect(cspJson).toContain("https://cognito-idp.ap-northeast-1.amazonaws.com");
    });

    it("form-action に Cognito domain wildcard を含むべき (= Hosted UI sign-in form)", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toMatch(/form-action[^;]*amazoncognito\.com/);
    });
  });

  describe("Issue #1031: runtime-config 分離", () => {
    it("RuntimeConfigDeployment を本 stack に持たないべき (= AdminConsoleRuntimeConfigStack に移管)", () => {
      const template = synth();
      // BucketDeployment は 1 つだけ (= SiteDeployment for dist/)、 旧 RuntimeConfigDeployment は無い。
      const bucketDeployments = template.findResources("Custom::CDKBucketDeployment");
      expect(Object.keys(bucketDeployments)).toHaveLength(1);
    });
  });
});
