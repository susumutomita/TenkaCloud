import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Code, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { ApiGateway } from "../../lib/tenant-template/api-gateway";
import type { CustomApiKey } from "../../lib/tenant-template/interfaces/custom-api-key";
import { LAMBDA_NODEJS_RUNTIME } from "../../lib/utils/lambda-runtime";

/**
 * tenant API Gateway の resource / method shape を pin する。サイドバー「デプロイ履歴」が引く
 * `GET /deployments` (no path param) を含む全 5 route が、Lambda 内 Hono router と整合
 * していることを担保する (= PR #467 で Lambda には追加したが Gateway resource を入れ忘れて
 * 403 + CORS error になった regression を防ぐ)。
 */

function buildHarness() {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  const userPool = new UserPool(stack, "UP");
  const fn = new LambdaFunction(stack, "DeployApi", {
    runtime: LAMBDA_NODEJS_RUNTIME,
    code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 })"),
    handler: "index.handler",
  });
  const eventFn = new LambdaFunction(stack, "EventApi", {
    runtime: LAMBDA_NODEJS_RUNTIME,
    code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 })"),
    handler: "index.handler",
  });
  const competitorAccountsFn = new LambdaFunction(stack, "CompetitorAccountsApi", {
    runtime: LAMBDA_NODEJS_RUNTIME,
    code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 })"),
    handler: "index.handler",
  });
  const apiKey: CustomApiKey = {
    id: "key-id",
    apiKey: { keyId: "k", keyArn: "arn:aws:apigateway:::/apikeys/k", keyName: "k" },
    apiKeyValue: "val",
  };
  new ApiGateway(stack, "ApiGateway", {
    tenantId: "tenant-acme",
    isPooledDeploy: false,
    idpDetails: {
      idpName: "COGNITO",
      details: {
        userPoolId: "u",
        appClientId: "c",
        cognitoDomain: "d",
        authorizationServerUrl: "https://example",
        authorizerArn: "arn",
      },
    },
    userPool,
    deployApiLambda: fn,
    eventApiLambda: eventFn,
    competitorAccountsApiLambda: competitorAccountsFn,
    apiKeyBasicTier: apiKey,
    apiKeyStandardTier: apiKey,
    apiKeyPremiumTier: apiKey,
    apiKeyPlatinumTier: apiKey,
  });
  return Template.fromStack(stack);
}

describe("tenant ApiGateway", () => {
  const tpl = buildHarness();

  /** PathPart で resource を 1 件抜く (`hasResourceProperties` だと 1 件以上の存在確認のみ)。 */
  function findResource(pathPart: string) {
    const resources = tpl.findResources("AWS::ApiGateway::Resource", {
      Properties: { PathPart: pathPart },
    });
    return Object.values(resources)[0];
  }

  it("/deployments resource が存在するべき", () => {
    expect(findResource("deployments")).toBeDefined();
  });

  it("/deployments に GET method が紐づいているべき (= サイドバー「デプロイ履歴」用)", () => {
    const deploymentsResource = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "deployments" } }),
    )[0]?.[0];
    expect(deploymentsResource).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: deploymentsResource },
    });
  });

  it("/deployments/{jobId} に GET と DELETE が紐づいているべき", () => {
    const jobIdResource = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "{jobId}" } }),
    )[0]?.[0];
    expect(jobIdResource).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: jobIdResource },
    });
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "DELETE",
      ResourceId: { Ref: jobIdResource },
    });
  });

  it("/problems/{problemId}/deploy に POST、/problems/{problemId}/deployments に GET が紐づくべき", () => {
    expect(findResource("deploy")).toBeDefined();
    expect(findResource("{problemId}")).toBeDefined();
  });

  it("/events/{eventId}/notifications resource + POST method が存在するべき (#553)", () => {
    // backend handler `POST /events/:eventId/notifications` (= ADR-006 通知 push) と
    // API Gateway route の配線がセットでないと frontend は "Failed to fetch" になる。
    // #535 と同種の「backend だけ merge、CDK 後追い」 regression を再発させないための pin。
    const notificationsResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "notifications" },
      }),
    )[0]?.[0];
    expect(notificationsResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: { Ref: notificationsResourceId },
    });
  });

  it("/admin/competitor-accounts と /admin/competitor-accounts/{awsAccountId}/verify を持つべき (Issue #459)", () => {
    // Issue #459 / ADR-002 Phase 2.1: Competitor Accounts CRUD + verify
    expect(findResource("admin")).toBeDefined();
    expect(findResource("competitor-accounts")).toBeDefined();
    expect(findResource("{awsAccountId}")).toBeDefined();
    expect(findResource("verify")).toBeDefined();

    const caResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "competitor-accounts" },
      }),
    )[0]?.[0];
    expect(caResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: caResourceId },
    });
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: { Ref: caResourceId },
    });
  });

  it("/admin/competitor-accounts/{awsAccountId}/rotate-external-id POST を持つべき (Issue #596)", () => {
    // Issue #596 / ADR-002 Phase 3.1: ExternalId rotation route
    expect(findResource("rotate-external-id")).toBeDefined();
    const rotateResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "rotate-external-id" },
      }),
    )[0]?.[0];
    expect(rotateResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: { Ref: rotateResourceId },
    });
  });
});
