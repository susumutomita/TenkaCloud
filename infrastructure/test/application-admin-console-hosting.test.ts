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
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new ApplicationAdminConsoleHosting(stack, "Hosting", { tenantId });
  return Template.fromStack(stack);
}

describe("ApplicationAdminConsoleHosting", () => {
  beforeAll(() => {
    ensurePlaceholderDist();
  });

  describe("テナント ID を渡してインスタンス化したとき", () => {
    it("S3 Bucket / CloudFront Distribution / OAI を 1 セット作るべき", () => {
      const template = synth("tenant-1");
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
      template.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 1);
    });

    it("S3 Bucket は public access を完全に block すべき", () => {
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

    it("S3 Bucket は server-side encryption を要求すべき", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      });
    });

    it("CloudFront Distribution は HTTPS リダイレクトと SPA fallback (403/404 → /index.html 200) を持つべき", () => {
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

    it("distributionDomainName と distributionUrl を property として公開すべき", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      const hosting = new ApplicationAdminConsoleHosting(stack, "Hosting", {
        tenantId: "tenant-1",
      });
      expect(hosting.distributionDomainName).toBeDefined();
      expect(hosting.distributionUrl).toMatch(/^https:\/\//);
    });
  });

  describe("pooled テナントの場合 (tenantId = pooled)", () => {
    it("silo と同じ構造 (Bucket / Distribution / OAI) を持つべき (構造は分岐させない設計)", () => {
      const template = synth("pooled");
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });
  });

  describe("deployRuntimeConfig() を呼び出したとき", () => {
    function synthWithRuntimeConfig() {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      const hosting = new ApplicationAdminConsoleHosting(stack, "Hosting", {
        tenantId: "tenant-1",
      });
      hosting.deployRuntimeConfig({
        cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
        cognitoClientId: "test-client",
        tenantId: "tenant-1",
        tenantName: "DENSO 第一事業部",
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

    it("BucketDeployment Custom Resource が 2 個に増えるべき (dist と runtime-config)", () => {
      const { template } = synthWithRuntimeConfig();
      template.resourceCountIs("Custom::CDKBucketDeployment", 2);
    });

    it("CloudFront 既存 distribution が同じ Bucket に対して使われ続けるべき (新 Bucket を作らない)", () => {
      const { template } = synthWithRuntimeConfig();
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
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
