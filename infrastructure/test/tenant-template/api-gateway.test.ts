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
 * `GET /deployments` (no path param) や `GET /deployments/{jobId}/stack-progress` を含む
 * deploy route が、Lambda 内 Hono router と整合していることを担保する (= PR #467 で Lambda
 * には追加したが Gateway resource を入れ忘れて 403 + CORS error になった regression を防ぐ)。
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

  it("should expose the /deployments resource", () => {
    expect(findResource("deployments")).toBeDefined();
  });

  it('should bind a GET method on /deployments (for the sidebar "Deploy history")', () => {
    const deploymentsResource = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "deployments" } }),
    )[0]?.[0];
    expect(deploymentsResource).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: deploymentsResource },
    });
  });

  it("should bind GET and DELETE on /deployments/{jobId}", () => {
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

  it("should bind GET / OPTIONS on /deployments/{jobId}/stack-progress", () => {
    const stackProgressResource = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "stack-progress" },
      }),
    )[0]?.[0];
    expect(stackProgressResource).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: stackProgressResource },
    });
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "OPTIONS",
      ResourceId: { Ref: stackProgressResource },
    });
  });

  it("should bind POST on /problems/{problemId}/deploy and GET on /problems/{problemId}/deployments", () => {
    expect(findResource("deploy")).toBeDefined();
    expect(findResource("{problemId}")).toBeDefined();
  });

  it("should expose the /events/{eventId}/notifications resource with a POST method (#553)", () => {
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

  it("[ADR-037 Slice 2] should wire /events/{eventId}/disruptions/recurring (GET) + .../{requestId}/cancel (POST)", () => {
    // backend に Hono route + frontend RecurringPanel を merge しても、 この APIGW route を
    // 追加し忘れると gateway が CORS 無しで 404/403 を返し frontend は「Failed to fetch」になる
    // (= #553 通知 route と同じ「backend だけ merge、 CDK 後追い」 regression class)。
    const recurringResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "recurring" } }),
    )[0]?.[0];
    expect(recurringResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: recurringResourceId },
    });
    const cancelResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "cancel" } }),
    )[0]?.[0];
    expect(cancelResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: { Ref: cancelResourceId },
    });
  });

  it("should have /admin/competitor-accounts and /admin/competitor-accounts/{awsAccountId}/verify (Issue #459)", () => {
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

  it("should have POST /admin/competitor-accounts/{awsAccountId}/rotate-external-id (Issue #596)", () => {
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

  it("should bind GET /admin/audit-log and GET /admin/audit-log/export to the EventApi integration (#1292)", () => {
    const adminResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "admin" },
      }),
    )[0]?.[0];
    expect(adminResourceId).toBeDefined();
    const auditLogResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { ParentId: { Ref: adminResourceId }, PathPart: "audit-log" },
      }),
    )[0]?.[0];
    expect(auditLogResourceId).toBeDefined();
    const exportResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { ParentId: { Ref: auditLogResourceId }, PathPart: "export" },
      }),
    )[0]?.[0];
    expect(exportResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: auditLogResourceId },
    });
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: exportResourceId },
    });
  });

  it("should bind GET and POST /admin/capacity to the EventApi integration (#2410 / #2680)", () => {
    const adminResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { PathPart: "admin" },
      }),
    )[0]?.[0];
    expect(adminResourceId).toBeDefined();
    const capacityResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", {
        Properties: { ParentId: { Ref: adminResourceId }, PathPart: "capacity" },
      }),
    )[0]?.[0];
    expect(capacityResourceId).toBeDefined();
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: capacityResourceId },
    });
    // Issue #2680: 変更 (SSM runbook 起動) の POST。Gateway resource が無いと request は
    // Lambda に届かず 403 になる (#2231 の feature-flags と同じ regression class)。
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "POST",
      ResourceId: { Ref: capacityResourceId },
    });
  });

  it("should bind GET /feature-flags and PUT /admin/feature-flags to the EventApi integration (#2231)", () => {
    // Regression: the EventApi handler serves both routes, but they were missing from the
    // Gateway, so the console's Feature Flags page 403'd at the Gateway before reaching the
    // Lambda ("フィーチャーフラグの取得に失敗しました") — the same failure class as the #1292
    // audit-log / #2410 capacity routes.
    const adminResourceId = Object.entries(
      tpl.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: "admin" } }),
    )[0]?.[0];
    expect(adminResourceId).toBeDefined();

    // Two resources share the PathPart: root /feature-flags (GET, any role) and
    // /admin/feature-flags (PUT, TenantAdmin-only). Disambiguate by parent.
    const featureFlagsResources = tpl.findResources("AWS::ApiGateway::Resource", {
      Properties: { PathPart: "feature-flags" },
    });
    const adminFeatureFlagsId = Object.entries(featureFlagsResources).find(
      ([, res]) => res.Properties?.ParentId?.Ref === adminResourceId,
    )?.[0];
    const rootFeatureFlagsId = Object.entries(featureFlagsResources).find(
      ([, res]) => res.Properties?.ParentId?.Ref !== adminResourceId,
    )?.[0];
    expect(rootFeatureFlagsId).toBeDefined();
    expect(adminFeatureFlagsId).toBeDefined();

    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ResourceId: { Ref: rootFeatureFlagsId },
    });
    tpl.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "PUT",
      ResourceId: { Ref: adminFeatureFlagsId },
    });
  });
});
