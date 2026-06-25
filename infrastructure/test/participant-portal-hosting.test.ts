import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    it("connect-src should include region-scoped wildcards for execute-api / lambda-url", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      expect(policy).toBeDefined();
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain(".execute-api.");
      expect(cspJson).toContain(".lambda-url.");
    });

    it("should not contain middle wildcards (CSP3 spec violation pattern)", () => {
      const template = synth();
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      expect(cspJson).not.toContain("*.execute-api.*");
      expect(cspJson).not.toContain("*.lambda-url.*");
    });
  });

  // 競技者全員が "Failed to fetch" になった live 障害の回帰防止。 原因は dev で `public/runtime-config.json`
  // に置いた mock (apiBaseUrl=http://127.0.0.1:3199) が Vite build で dist に混入し、 SPA 配信
  // (SiteDeployment) が deployRuntimeConfig の実 Function URL を上書きしていたこと。 SiteDeployment は
  // runtime-config.json を asset から exclude し、 絶対に出荷しないことを pin する。
  describe("runtime-config.json must never ship via the SPA deployment", () => {
    const strayRuntimeConfig = path.join(distDir, "runtime-config.json");
    let planted = false;

    beforeAll(() => {
      ensurePlaceholderDist();
      // dev の public/runtime-config.json が build で dist に混入した状況を再現する。
      if (!fs.existsSync(strayRuntimeConfig)) {
        fs.writeFileSync(
          strayRuntimeConfig,
          JSON.stringify({
            apiBaseUrl: "http://127.0.0.1:3199",
            mode: "backend",
            cloudMode: "mock",
          }),
        );
        planted = true;
      }
    });

    afterAll(() => {
      // テストが植えた mock のみ後始末する (既存の実 build を壊さない)。
      if (planted && fs.existsSync(strayRuntimeConfig)) {
        fs.rmSync(strayRuntimeConfig);
      }
    });

    it("should exclude a stray dist/runtime-config.json from the SPA asset", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "PortalLeakStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      // deployRuntimeConfig は呼ばない (= SiteDeployment 単独)。 それでも asset に runtime-config.json が
      // 出るなら、 SPA 配信が mock を出荷している証拠。 exclude が効いていれば 0 件。
      new ParticipantPortalHosting(stack, "Portal");
      const assemblyDir = cdk.App.of(stack)?.synth().directory;
      if (!assemblyDir) throw new Error("synth output unavailable");
      const leaking = fs
        .readdirSync(assemblyDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("asset."))
        .filter((d) => fs.existsSync(path.join(assemblyDir, d.name, "runtime-config.json")))
        .map((d) => d.name);
      expect(leaking).toEqual([]);
    });
  });
});
