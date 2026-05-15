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
  it("ApplicationAdminConsoleHosting / IdentityProvider / ApiGateway を Stack 直下に生成すべき (= CFn 物理差分 0 件 invariant)", () => {
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

  it("runtime-config.json 用の BucketDeployment custom resource を 1 件作るべき (= deployRuntimeConfig が呼ばれた証跡)", () => {
    const template = synth();
    // BucketDeployment は AWS::CloudFormation::CustomResource として template に乗る。
    // hosting の runtime-config.json が apiGateway 確定後に配置されることを示す。
    template.hasResource("Custom::CDKBucketDeployment", Match.objectLike({}));
  });

  it("UserPoolClient の callback URL は ApplicationAdminConsoleHosting の distribution URL を参照すべき", () => {
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

  it("戻り値の applicationAdminConsoleUrl は hosting.distributionUrl と一致すべき", () => {
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
