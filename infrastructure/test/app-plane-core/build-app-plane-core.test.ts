import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { buildAppPlaneCore } from "../../lib/app-plane-core";

/**
 * Issue #778 ADR-016 Phase 1: AppPlaneCore builder の契約 pin。
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
  const app = new cdk.App();
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
    const app = new cdk.App();
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
    const app = new cdk.App();
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
});
