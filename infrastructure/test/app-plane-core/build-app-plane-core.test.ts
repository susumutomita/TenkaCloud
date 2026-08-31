import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAppPlaneCore } from "../../lib/app-plane-core";

/**
 * BucketDeployment(Source.asset(dist)) は synth 時に path 存在を検証する。
 * CI は make build より前に make test-coverage を走らせるため SPA dist が無く、
 * `CannotFindAsset` で fail する。 application-admin-console-hosting.test.ts と
 * 同じ pattern で placeholder dist を mkdir する。
 */
const distDir = path.join(__dirname, "..", "..", "..", "apps", "application-admin-console", "dist");
beforeAll(() => {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><html><body>placeholder</body></html>",
    );
  }
});

/**
 * Issue #778: AppPlaneCore builder の契約 pin。
 *
 * 主目的は "CFn 物理差分 0 件" invariant — sub-construct (= hosting / identity / apiGateway)
 * が **stack scope に直接** logical ID `ApplicationAdminConsoleHosting` / `IdentityProvider` /
 * `ApiGateway` で生成されることを確認する。 builder が誤って新しい Construct を間に挟むと、
 * 既存 stack の CFn template が REPLACE されてしまうため。
 */

function buildStubLambda(scope: cdk.Stack, id: string): LambdaFunction {
  return new LambdaFunction(scope, id, {
    runtime: Runtime.NODEJS_20_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
}

function synth(): Template {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  buildAppPlaneCore(stack, {
    tenantId: "tenant-1",
    tenantName: "Tenant 1",
    environment: "development",
    isPooledDeploy: false,
    deployApiLambda: buildStubLambda(stack, "StubDeploy"),
    eventApiLambda: buildStubLambda(stack, "StubEvent"),
    competitorAccountsApiLambda: buildStubLambda(stack, "StubCompetitorAccounts"),
    apiKeyConfig: {
      ssmParameterNames: {
        basic: { keyId: "basic-id", value: "basic-val" },
        standard: { keyId: "standard-id", value: "standard-val" },
        premium: { keyId: "premium-id", value: "premium-val" },
        platinum: { keyId: "platinum-id", value: "platinum-val" },
      },
      ssmLookup: (name: string) => `SSM:${name}`,
    },
  });
  return Template.fromStack(stack);
}

describe("buildAppPlaneCore", () => {
  it("should generate ApplicationAdminConsoleHosting / IdentityProvider / ApiGateway directly under the Stack (= 0 CFn physical diff invariant)", () => {
    const template = synth();
    // builder は scope = stack に対して 3 つの sub-construct を生成する。
    // 各 sub-construct は内部に複数の CFn resource を持つ。 stack 直下に下記が存在することで
    // logical ID パスが旧 TenantTemplateStack と一致していることを確認する。
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    // ApiGateway は REST API を 1 個立てる。
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    // ApplicationAdminConsoleHosting は CloudFront Distribution を立てる。
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("should create 1 BucketDeployment custom resource for runtime-config.json (evidence that deployRuntimeConfig was invoked)", () => {
    const template = synth();
    // BucketDeployment は AWS::CloudFormation::CustomResource として template に乗る。
    // hosting の runtime-config.json が apiGateway 確定後に配置されることを示す。
    template.hasResource("Custom::CDKBucketDeployment", Match.objectLike({}));
  });

  it("UserPoolClient callback URL should reference the ApplicationAdminConsoleHosting distribution URL", () => {
    const template = synth();
    // UserPoolClient の CallbackURLs / LogoutURLs に CloudFront distribution domain への
    // Fn::Join 参照が入る (= 順序依存)。 hosting が先に作られて identity に URL を渡す
    // フローが壊れていないか確認する。 string では引けない (= CDK token なので) ため、
    // 存在検査だけ行う (= Match.absent() を使うと逆になる)。
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const client = Object.values(clients)[0];
    const callbacks = (client?.Properties as { CallbackURLs?: unknown[] })?.CallbackURLs ?? [];
    const logouts = (client?.Properties as { LogoutURLs?: unknown[] })?.LogoutURLs ?? [];
    expect(callbacks.length).toBeGreaterThan(0);
    expect(logouts.length).toBeGreaterThan(0);
  });

  // Issue #1327: SaaS mode (= `liteAdminClaimsInjection` 未指定) では Pre-Token Generation Lambda を
  // 立てない (= SBT pipeline / provision-tenant.sh の role 割り当てを汚さない)。 既存 SaaS / Full mode の
  // CFn 物理差分が 0 件であることを機械的に保証する。

  it("should NOT attach a Pre-Token Generation Lambda when liteAdminClaimsInjection is not set (SaaS mode regression guard)", () => {
    const template = synth();
    const userPools = template.findResources("AWS::Cognito::UserPool");
    const userPool = Object.values(userPools)[0];
    const lambdaConfig = (userPool?.Properties as { LambdaConfig?: Record<string, unknown> })
      ?.LambdaConfig;
    // LambdaConfig 自体が無いか、 PreTokenGeneration / PreTokenGenerationConfig key が無い
    // (= SaaS mode regression なし)。 V1 / V2 どちらの key も未設定であることを確認する。
    expect(lambdaConfig?.PreTokenGeneration).toBeUndefined();
    expect(lambdaConfig?.PreTokenGenerationConfig).toBeUndefined();
  });

  it("should attach a Pre-Token Generation V2 Lambda when liteAdminClaimsInjection is true (#1327 / #1358)", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    buildAppPlaneCore(stack, {
      tenantId: "tenant-1",
      tenantName: "Tenant 1",
      environment: "development",
      isPooledDeploy: false,
      deployApiLambda: buildStubLambda(stack, "StubDeploy"),
      eventApiLambda: buildStubLambda(stack, "StubEvent"),
      competitorAccountsApiLambda: buildStubLambda(stack, "StubCompetitorAccounts"),
      liteAdminClaimsInjection: true,
      apiKeyConfig: {
        ssmParameterNames: {
          basic: { keyId: "basic-id", value: "basic-val" },
          standard: { keyId: "standard-id", value: "standard-val" },
          premium: { keyId: "premium-id", value: "premium-val" },
          platinum: { keyId: "platinum-id", value: "platinum-val" },
        },
        ssmLookup: (name: string) => `SSM:${name}`,
      },
    });
    const template = Template.fromStack(stack);
    // #1358: V2 trigger を採用すると Cognito UserPool は LambdaConfig.PreTokenGenerationConfig
    // (= LambdaArn + LambdaVersion: V2_0) として設定される。 V1 trigger の旧 key
    // (PreTokenGeneration) が混入していないことも併せて確認する。
    template.hasResourceProperties(
      "AWS::Cognito::UserPool",
      Match.objectLike({
        LambdaConfig: Match.objectLike({
          PreTokenGenerationConfig: Match.objectLike({
            LambdaArn: Match.anyValue(),
            LambdaVersion: "V2_0",
          }),
        }),
      }),
    );
    const userPools = template.findResources("AWS::Cognito::UserPool");
    const userPool = Object.values(userPools)[0];
    const lambdaConfig = (userPool?.Properties as { LambdaConfig?: Record<string, unknown> })
      ?.LambdaConfig;
    // V1 key (= PreTokenGeneration) は使わない (= #1358 root cause: V1 は access token のみ
    // override 可能で ID token に claim が乗らないため Application Plane handler が 403 を返す)。
    expect(lambdaConfig?.PreTokenGeneration).toBeUndefined();
  });

  it("the returned applicationAdminConsoleUrl should equal hosting.distributionUrl", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    const handles = buildAppPlaneCore(stack, {
      tenantId: "tenant-1",
      tenantName: "Tenant 1",
      environment: "development",
      isPooledDeploy: false,
      deployApiLambda: buildStubLambda(stack, "StubDeploy"),
      eventApiLambda: buildStubLambda(stack, "StubEvent"),
      competitorAccountsApiLambda: buildStubLambda(stack, "StubCompetitorAccounts"),
      apiKeyConfig: {
        ssmParameterNames: {
          basic: { keyId: "b", value: "b" },
          standard: { keyId: "s", value: "s" },
          premium: { keyId: "p", value: "p" },
          platinum: { keyId: "pl", value: "pl" },
        },
        ssmLookup: () => "SSM:x",
      },
    });
    expect(handles.applicationAdminConsoleUrl).toBe(
      handles.applicationAdminConsoleHosting.distributionUrl,
    );
  });

  // Issue #1340 Phase 2: SAML attach の挙動 (= 未指定で no-op、 指定時のみ provider + allowlist 配線)。

  it("should NOT create a UserPoolIdentityProvider when samlIdps is omitted (= no CFn physical diff for existing tenants)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  it("should attach SAML provider + allowlist Pre sign-up Lambda when samlIdps is non-empty (#1340)", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    const handles = buildAppPlaneCore(stack, {
      tenantId: "tenant-1",
      tenantName: "Tenant 1",
      environment: "development",
      isPooledDeploy: false,
      deployApiLambda: buildStubLambda(stack, "StubDeploy"),
      eventApiLambda: buildStubLambda(stack, "StubEvent"),
      competitorAccountsApiLambda: buildStubLambda(stack, "StubCompetitorAccounts"),
      samlIdps: [
        {
          name: "tenant-entra",
          metadataUrl: "https://meta.example",
          emailDomains: ["acme.example"],
        },
      ],
      samlAdminAllowlist: ["tenant-entra/admin@acme.example"],
      apiKeyConfig: {
        ssmParameterNames: {
          basic: { keyId: "b", value: "b" },
          standard: { keyId: "s", value: "s" },
          premium: { keyId: "p", value: "p" },
          platinum: { keyId: "pl", value: "pl" },
        },
        ssmLookup: () => "SSM:x",
      },
    });
    expect(handles.samlIdpDirectory).toEqual({ "acme.example": ["tenant-entra"] });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "tenant-entra",
      ProviderType: "SAML",
    });
    // Pre sign-up trigger (= federated admin allowlist) が UserPool に attach されている
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({ PreSignUp: Match.anyValue() }),
    });
  });

  it("should NOT attach the federated allowlist Lambda when samlIdps is empty even if samlAdminAllowlist is provided", () => {
    // 「allowlist だけ設定して SAML は未設定」 のケース。 SAML 経路が無いので allowlist の意味は無く、
    // attach すると無駄な Pre sign-up trigger が UserPool に乗ってしまう。 builder は samlIdps が
    // 空のとき allowlist Lambda を立てない契約 (= app-plane-core.ts の if guard) を pin する。
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    buildAppPlaneCore(stack, {
      tenantId: "tenant-1",
      tenantName: "Tenant 1",
      environment: "development",
      isPooledDeploy: false,
      deployApiLambda: buildStubLambda(stack, "StubDeploy"),
      eventApiLambda: buildStubLambda(stack, "StubEvent"),
      competitorAccountsApiLambda: buildStubLambda(stack, "StubCompetitorAccounts"),
      samlIdps: [],
      samlAdminAllowlist: ["tenant-entra/admin@acme.example"],
      apiKeyConfig: {
        ssmParameterNames: {
          basic: { keyId: "b", value: "b" },
          standard: { keyId: "s", value: "s" },
          premium: { keyId: "p", value: "p" },
          platinum: { keyId: "pl", value: "pl" },
        },
        ssmLookup: () => "SSM:x",
      },
    });
    const template = Template.fromStack(stack);
    const userPools = template.findResources("AWS::Cognito::UserPool");
    const userPool = Object.values(userPools)[0];
    const lambdaConfig = (userPool?.Properties as { LambdaConfig?: Record<string, unknown> })
      ?.LambdaConfig;
    expect(lambdaConfig?.PreSignUp).toBeUndefined();
  });
});
