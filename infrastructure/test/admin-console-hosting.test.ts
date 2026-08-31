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
  const app = new cdk.App({ autoSynth: false });
  const stack = new AdminConsoleHostingStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  return Template.fromStack(stack);
}

function synthWithCustomDomain(): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new AdminConsoleHostingStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    customDomain: {
      domainName: "console.tenkacloud.cloud",
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
    },
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleHostingStack", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("CloudFront security headers (CSP wildcard, Issue #1031)", () => {
    it("connect-src should include the execute-api region wildcard", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      expect(policy).toBeDefined();
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://*.execute-api.ap-northeast-1.amazonaws.com");
    });

    it("connect-src should include the Cognito domain wildcard", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain("https://*.amazoncognito.com");
      expect(cspJson).toContain("https://cognito-idp.ap-northeast-1.amazonaws.com");
    });

    it("form-action should include the Cognito domain wildcard (Hosted UI sign-in form)", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toMatch(/form-action[^;]*amazoncognito\.com/);
    });
  });

  describe("Issue #1695: opt-in custom domain → TLS 1.2", () => {
    it("should use the default certificate and NOT pin a min TLS version when no custom domain is set", () => {
      const dists = synth().findResources("AWS::CloudFront::Distribution");
      const cfg = Object.values(dists)[0]?.Properties?.DistributionConfig;
      // CDK は default 証明書のとき ViewerCertificate ブロックを emit しない (= CloudFront 既定)。
      // よって alias も min TLS も付かない (= 現状デプロイの挙動と同一)。
      expect(cfg?.Aliases).toBeUndefined();
      expect(cfg?.ViewerCertificate?.MinimumProtocolVersion).toBeUndefined();
    });

    it("should enforce TLSv1.2_2021 with the ACM cert + alias when a custom domain is set", () => {
      const template = synthWithCustomDomain();
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Aliases: ["console.tenkacloud.cloud"],
          ViewerCertificate: {
            AcmCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",
            MinimumProtocolVersion: "TLSv1.2_2021",
            SslSupportMethod: "sni-only",
          },
        },
      });
    });
  });

  describe("Issue #1031: runtime-config 分離", () => {
    it("should not have RuntimeConfigDeployment in this stack (migrated to AdminConsoleRuntimeConfigStack)", () => {
      const template = synth();
      // BucketDeployment は 1 つだけ (= SiteDeployment for dist/)、 旧 RuntimeConfigDeployment は無い。
      const bucketDeployments = template.findResources("Custom::CDKBucketDeployment");
      expect(Object.keys(bucketDeployments)).toHaveLength(1);
    });
  });
});
