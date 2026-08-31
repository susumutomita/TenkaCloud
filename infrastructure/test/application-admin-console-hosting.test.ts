import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { ApplicationAdminConsoleHosting } from "../lib/tenant-template/application-admin-console-hosting";

/**
 * Construct が参照する dist/ 実体は install.sh が build して用意するが、
 * ローカル test / CI では未 build のことがある。BucketDeployment の Source.asset は
 * synth 時に path 存在を検証するので、無ければ最小 placeholder を作る。
 * 実際の vite build が走った後はそれで上書きされるので副作用は実質無い。
 */
const distDir = path.join(__dirname, "..", "..", "apps", "application-admin-console", "dist");

function ensurePlaceholderDist() {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><html><body>placeholder</body></html>",
    );
  }
}

function synth(tenantId: string): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack");
  new ApplicationAdminConsoleHosting(stack, "Hosting", { tenantId });
  return Template.fromStack(stack);
}

describe("ApplicationAdminConsoleHosting", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("テナント ID を渡してインスタンス化したとき", () => {
    it("should create 1 set of S3 Bucket / CloudFront Distribution / OAI", () => {
      const template = synth("tenant-1");
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
      template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 1);
    });

    it("S3 Bucket should fully block public access", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("S3 Bucket should require server-side encryption", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      });
    });

    it("CloudFront Distribution should have HTTPS redirect and SPA fallback (403/404 → /index.html 200)", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          DefaultCacheBehavior: { ViewerProtocolPolicy: "redirect-to-https" },
          DefaultRootObject: "index.html",
          CustomErrorResponses: [
            { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" },
            { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" },
          ],
        },
      });
    });

    // Issue #896: CSP3 spec で wildcard は **leftmost only**。 中段 `*` 入りの host-source は
    // ブラウザが silently ignore して全 fetch が \"Refused to connect by CSP\" で fail する。
    it("Content-Security-Policy connect-src should not contain middle wildcards (CSP3 spec)", () => {
      const template = synth("tenant-1");
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      const cspJson = JSON.stringify(policy);
      // 旧 regression pattern (= middle wildcard) が混入していないことを直接 string で検査
      expect(cspJson).not.toContain("*.execute-api.*");
      expect(cspJson).not.toContain("*.lambda-url.*");
    });

    it("Content-Security-Policy connect-src should include execute-api / lambda-url / cognito", () => {
      const template = synth("tenant-1");
      const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const policy = Object.values(policies)[0];
      // region は Stack.region で token 化されるため、 CFn template 上は Fn::Join 配下の
      // string fragment に含まれる。 stringify した template 全体に対して string match。
      const cspJson = JSON.stringify(policy);
      expect(cspJson).toContain(".execute-api.");
      expect(cspJson).toContain(".lambda-url.");
      expect(cspJson).toContain("amazoncognito.com");
    });

    it("should expose distributionDomainName and distributionUrl as properties", () => {
      const app = new cdk.App({ autoSynth: false });
      const stack = new cdk.Stack(app, "TestStack");
      const hosting = new ApplicationAdminConsoleHosting(stack, "Hosting", {
        tenantId: "tenant-1",
      });
      expect(hosting.distributionDomainName).toBeDefined();
      expect(hosting.distributionUrl).toMatch(/^https:\/\//);
    });
  });

  describe("pooled テナントの場合 (tenantId = pooled)", () => {
    it("should mirror the silo structure (Bucket / Distribution / OAI) (no structural divergence by design)", () => {
      const template = synth("pooled");
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });
  });

  describe("deployRuntimeConfig() を呼び出したとき", () => {
    function synthWithRuntimeConfig() {
      const app = new cdk.App({ autoSynth: false });
      const stack = new cdk.Stack(app, "TestStack");
      const hosting = new ApplicationAdminConsoleHosting(stack, "Hosting", {
        tenantId: "tenant-1",
      });
      hosting.deployRuntimeConfig({
        cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
        cognitoClientId: "test-client",
        tenantId: "tenant-1",
        tenantName: "Acme Manufacturing Division",
        apiUrl: "https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/",
      });
      return { template: Template.fromStack(stack), stack };
    }

    function readRuntimeConfigJson(stack: cdk.Stack): Record<string, unknown> {
      const synth = cdk.App.of(stack)?.synth();
      if (!synth) throw new Error("synth output unavailable");
      const assemblyDir = synth.directory;
      const assets = fs
        .readdirSync(assemblyDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("asset."));
      for (const asset of assets) {
        const candidate = path.join(assemblyDir, asset.name, "runtime-config.json");
        if (fs.existsSync(candidate)) {
          return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
        }
      }
      throw new Error("runtime-config.json asset not found");
    }

    it("should grow to 2 BucketDeployment Custom Resources (dist and runtime-config)", () => {
      const { template } = synthWithRuntimeConfig();
      template.resourceCountIs("Custom::CDKBucketDeployment", 2);
    });

    it("should keep using the existing CloudFront distribution against the same Bucket (no new Bucket)", () => {
      const { template } = synthWithRuntimeConfig();
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });

    it("Issue #2230: features 未設定なら features key 自体を書かない (= 旧 runtime-config と互換)", () => {
      const { stack } = synthWithRuntimeConfig();
      const json = readRuntimeConfigJson(stack);
      expect("features" in json).toBe(false);
    });

    it("Issue #458 後: runtime-config.json に deployApiUrl は出ない (Deploy 系 endpoint は apiUrl に統合)", () => {
      const { stack } = synthWithRuntimeConfig();
      const json = readRuntimeConfigJson(stack);
      expect(json.deployApiUrl).toBeUndefined();
      expect(json.cognitoDomain).toBeDefined();
      expect(json.userClientId).toBeDefined();
      expect(json.tenantId).toBeDefined();
      expect(json.tenantName).toBeDefined();
      expect(json.apiUrl).toBeDefined();
    });
  });
});

describe("Issue #2230: features を渡して deployRuntimeConfig を呼んだとき", () => {
  it("should bake the features map into runtime-config.json", () => {
    // 共有 CDK_OUTDIR を他 fixture の asset と共有すると誤読するため、専用 outdir で synth する。
    const outdirBase =
      process.env.CDK_OUTDIR ?? path.join(__dirname, "..", "cdk.out", "test-synth");
    fs.mkdirSync(outdirBase, { recursive: true });
    const outdir = fs.mkdtempSync(path.join(outdirBase, "features-test-"));
    const app = new cdk.App({ autoSynth: false, outdir });
    const stack = new cdk.Stack(app, "FeaturesTestStack");
    const hosting = new ApplicationAdminConsoleHosting(stack, "Hosting", {
      tenantId: "tenant-1",
    });
    hosting.deployRuntimeConfig({
      cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
      cognitoClientId: "test-client",
      tenantId: "tenant-1",
      tenantName: "Acme Manufacturing Division",
      apiUrl: "https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/",
      isolation: "silo",
      samlIdpDirectory: {},
      features: { nonAwsRuntime: true, redTeam: false },
    });
    const assemblyDir = app.synth().directory;
    const assetDir = fs
      .readdirSync(assemblyDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("asset."))
      .map((d) => path.join(assemblyDir, d.name, "runtime-config.json"))
      .find((candidate) => fs.existsSync(candidate));
    if (!assetDir) throw new Error("runtime-config.json asset not found");
    const json = JSON.parse(fs.readFileSync(assetDir, "utf-8")) as Record<string, unknown>;
    expect(json.features).toEqual({ nonAwsRuntime: true, redTeam: false });
    expect(json.isolation).toBe("silo");
  });
});
