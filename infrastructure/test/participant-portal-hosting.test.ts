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
  const app = new cdk.App({ autoSynth: false });
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
      const app = new cdk.App({ autoSynth: false });
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

  // Issue #867 / #2207: runtime-config.json は deployRuntimeConfig 経由でのみ配信され、
  // no-cache + /runtime-config.json invalidation + 末尾スラッシュ正規化を維持する。
  describe("deployRuntimeConfig", () => {
    function synthWithRuntimeConfig(coordinationApiUrl?: string): Template {
      const app = new cdk.App({ autoSynth: false });
      const stack = new cdk.Stack(app, "RuntimeConfigStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      const hosting = new ParticipantPortalHosting(stack, "Portal");
      hosting.deployRuntimeConfig({
        apiBaseUrl: "https://api.example.com/",
        eventTitle: "Spring Cup",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        ...(coordinationApiUrl ? { coordinationApiUrl } : {}),
      });
      return Template.fromStack(stack);
    }

    it("should deploy runtime-config.json with no-cache headers and invalidation", () => {
      const template = synthWithRuntimeConfig();
      template.hasResourceProperties("Custom::CDKBucketDeployment", {
        SystemMetadata: { "cache-control": "no-store, no-cache, must-revalidate" },
        DistributionPaths: ["/runtime-config.json"],
        Prune: false,
      });
    });

    // Source.jsonData は中身をテンプレートではなく asset (S3 zip) に焼くため、 値の検証は
    // synth した assembly から runtime-config deployment の SourceObjectKeys が指す asset を
    // 読んで行う (= 共有 CDK_OUTDIR に残る他テストの asset に影響されない、 keyed lookup)。
    function readRuntimeConfigAsset(coordinationApiUrl?: string): Record<string, unknown> {
      const app = new cdk.App({ autoSynth: false });
      const stack = new cdk.Stack(app, "RuntimeConfigContentStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      const hosting = new ParticipantPortalHosting(stack, "Portal");
      hosting.deployRuntimeConfig({
        apiBaseUrl: "https://api.example.com/",
        eventTitle: "Spring Cup",
        eventRegion: "ap-northeast-1",
        mode: "backend",
        ...(coordinationApiUrl ? { coordinationApiUrl } : {}),
      });
      const assemblyDir = app.synth().directory;
      const deployments = Template.fromStack(stack).findResources("Custom::CDKBucketDeployment", {
        Properties: { DistributionPaths: ["/runtime-config.json"] },
      });
      const [resource] = Object.values(deployments) as [
        { Properties: { SourceObjectKeys: [string] } },
      ];
      const [sourceKey] = resource.Properties.SourceObjectKeys;
      const assetDir = path.join(assemblyDir, `asset.${sourceKey.replace(/\.zip$/, "")}`);
      return JSON.parse(fs.readFileSync(path.join(assetDir, "runtime-config.json"), "utf8"));
    }

    it("should strip trailing slashes from apiBaseUrl and coordinationApiUrl", () => {
      const data = readRuntimeConfigAsset("https://coord.example.com/");
      expect(data.apiBaseUrl).toBe("https://api.example.com");
      expect(data.coordinationApiUrl).toBe("https://coord.example.com");
    });

    it("should omit coordinationApiUrl when the dispatcher is not wired", () => {
      const data = readRuntimeConfigAsset();
      expect(data).not.toHaveProperty("coordinationApiUrl");
      expect(data.mode).toBe("backend");
    });
  });
});
