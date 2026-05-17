import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ParticipantPortalHosting } from "../lib/problem-deploy/participant-portal-hosting";

/**
 * Issue #896: participant-portal-hosting の CSP wildcard regression を検出する test。
 *
 * 旧 `*.execute-api.*.amazonaws.com` / `*.lambda-url.*.on.aws` は CSP3 spec の \"wildcard は
 * leftmost host component のみ\" に違反していてブラウザが silently ignore → 全 fetch fail。
 */
const distDir = path.join(__dirname, "..", "..", "apps", "participant-portal", "dist");

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
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  new ParticipantPortalHosting(stack, "Portal");
  return Template.fromStack(stack);
}

describe("ParticipantPortalHosting", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("CloudFront security headers (CSP) — Issue #896", () => {
    it("connect-src に execute-api / lambda-url の region 付き wildcard を含むべき", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      expect(policy).toBeDefined();
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain(".execute-api.");
      expect(cspJson).toContain(".lambda-url.");
    });

    it("middle wildcard (CSP3 spec 違反 pattern) を含むべきでない", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).not.toContain("*.execute-api.*");
      expect(cspJson).not.toContain("*.lambda-url.*");
    });
  });
});
