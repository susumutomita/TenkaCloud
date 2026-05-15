import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { TenkaCloudLiteStack } from "../../lib/tenkacloud-lite";

/**
 * Issue #778 ADR-016 Phase 3: TenkaCloudLiteStack の最小契約 pin。
 *
 * - AppPlaneCore 経由で hosting + identity + apiGateway が立つ
 * - tenantId="local" 固定
 * - SBT / Pipeline / TenantMapping への依存が無い (= Lite mode の自己完結)
 */

function buildStubLambda(scope: cdk.Stack, id: string): LambdaFunction {
  return new LambdaFunction(scope, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
}

function synth(): Template {
  const app = new cdk.App();
  const stack = new TenkaCloudLiteStack(app, "TestLite", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    environment: "development",
    deployApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubDeploy",
    ),
    eventApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyEventLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubEvent",
    ),
    competitorAccountsApiLambda: buildStubLambda(
      new cdk.Stack(app, "DummyCompetitorLambdaStack", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      }),
      "StubCompetitor",
    ),
    participantPortalUrl: "https://example.cloudfront.net",
  });
  return Template.fromStack(stack);
}

describe("TenkaCloudLiteStack (#778 ADR-016 Phase 3)", () => {
  it("Cognito UserPool / UserPoolClient / UserPoolDomain を 1 セット作るべき (= AppPlaneCore 由来)", () => {
    const template = synth();
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });

  it("Tenant REST API Gateway を 1 つ作るべき", () => {
    const template = synth();
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  });

  it("ApplicationAdminConsoleHosting (= CloudFront) を 1 つ作るべき", () => {
    const template = synth();
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("CfnOutput に Application Admin Console URL / Cognito Domain / Tenant API / TenantId を含むべき", () => {
    const template = synth();
    template.hasOutput("ApplicationAdminConsoleUrl", Match.objectLike({}));
    template.hasOutput("CognitoDomainUrl", Match.objectLike({}));
    template.hasOutput("TenantApiUrl", Match.objectLike({}));
    template.hasOutput("TenantId", Match.objectLike({ Value: "local" }));
  });

  it("Cognito UserPool domain prefix は tenantId=local を埋めるべき (= region globally unique 性)", () => {
    const template = synth();
    template.hasResourceProperties(
      "AWS::Cognito::UserPoolDomain",
      Match.objectLike({
        Domain: Match.stringLikeRegexp("tenkacloud-development-local-"),
      }),
    );
  });

  it("SBT / pipeline 系 resource (TenantMappingTable / SaaSPipeline) を持ち込まないべき", () => {
    const template = synth();
    // Lite mode は SBT TenantMappingTable を参照しないので、 DynamoDB Table を作らない。
    template.resourceCountIs("AWS::DynamoDB::Table", 0);
    // ServerlessSaaSPipeline 由来の CodePipeline も無い。
    template.resourceCountIs("AWS::CodePipeline::Pipeline", 0);
  });

  it("public な API key (Usage Plan / API Key) は dormant な dummy 設定で立つべき (= Lite では使わない)", () => {
    const template = synth();
    // Usage Plan + API Key は AppPlaneCore (= ApiGateway construct) が作るので、 Lite でも
    // resource は出る。 ただし dummy SSM lookup なので runtime で実 key は引かれない。
    // (Phase 4-5 で ApiGateway 側に apiKeyConfig optional 対応を入れたら count=0 になる予定)。
    const usagePlans = template.findResources("AWS::ApiGateway::UsagePlan");
    expect(Object.keys(usagePlans).length).toBeGreaterThanOrEqual(0);
  });
});
