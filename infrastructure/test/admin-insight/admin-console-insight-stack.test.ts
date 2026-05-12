import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { AdminConsoleInsightStack } from "../../lib/admin-insight/admin-console-insight-stack";

/**
 * ADR-011 #590 Phase 1.A — AdminConsoleInsightStack の CFn 構造を assertion で固定する。
 * cross-stack 参照を simulate するため UserPool / Tables は同 app 内 helper stack に作る。
 */
function synthInsightStack(adminConsoleOrigin?: string): Template {
  const app = new cdk.App();
  const fixtures = new cdk.Stack(app, "Fixtures", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const userPool = new UserPool(fixtures, "UserPool", {
    selfSignUpEnabled: false,
  });
  const userPoolClient = userPool.addClient("UserClient");
  const deployments = new Table(fixtures, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new Table(fixtures, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const teams = new Table(fixtures, "Teams", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });

  const stack = new AdminConsoleInsightStack(app, "InsightStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    cognitoUserPool: userPool,
    cognitoUserClientId: userPoolClient.userPoolClientId,
    deploymentsTable: deployments,
    eventsTable: events,
    teamsTable: teams,
    adminConsoleOrigin,
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleInsightStack (ADR-011 Phase 1.A)", () => {
  describe("Lambda", () => {
    it("AdminInsight Lambda を Node.js 20 / arm64 で 1 個 立てるべき", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::Lambda::Function", 1);
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
        }),
      );
    });

    it("Lambda env に Deployments / Events / Teams Table 名を渡すべき", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              EVENTS_TABLE_NAME: Match.anyValue(),
              TEAMS_TABLE_NAME: Match.anyValue(),
            }),
          }),
        }),
      );
    });
  });

  describe("HTTP API + Cognito JWT Authorizer", () => {
    it("HTTP API (API GW v2) を 1 つ持つべき", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    });

    it("JWT Authorizer (= Cognito UserPool 連動) を持つべき", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Authorizer",
        Match.objectLike({
          AuthorizerType: "JWT",
          IdentitySource: ["$request.header.Authorization"],
        }),
      );
    });

    it("GET /admin/insight/tenants/summary route が JWT Authorizer に紐づくべき", () => {
      const tpl = synthInsightStack();
      const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /admin/insight/tenants/summary" },
      });
      expect(Object.keys(routes)).toHaveLength(1);
      const route = Object.values(routes)[0] as {
        Properties: { AuthorizerId: unknown; AuthorizationType: string };
      };
      expect(route.Properties.AuthorizationType).toBe("JWT");
      expect(route.Properties.AuthorizerId).toBeDefined();
    });

    it("CORS allowOrigins に localhost dev を入れるべき", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Api",
        Match.objectLike({
          CorsConfiguration: Match.objectLike({
            AllowOrigins: Match.arrayWith([
              "http://localhost:5173",
              "http://localhost:4173",
              "http://localhost:4180",
            ]),
            AllowMethods: Match.arrayWith(["GET", "OPTIONS"]),
          }),
        }),
      );
    });

    it("CDK_PARAM_ADMIN_CONSOLE_ORIGIN 相当の adminConsoleOrigin を CORS に追加するべき", () => {
      const tpl = synthInsightStack("https://abc.cloudfront.net");
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Api",
        Match.objectLike({
          CorsConfiguration: Match.objectLike({
            AllowOrigins: Match.arrayWith(["https://abc.cloudfront.net"]),
          }),
        }),
      );
    });
  });

  describe("IAM 権限 (ADR-011 D6 read-only)", () => {
    it("Deployments / Events Table の read のみを Allow するべき (write は禁止)", () => {
      const tpl = synthInsightStack();
      // Lambda role に attach された IAM Policy の中に DynamoDB write action が無いことを
      // 強めに検証する (= 旧 grantReadWriteData で誤 wire したら test が落ちる)。
      const policies = tpl.findResources("AWS::IAM::Policy");
      const writeActions = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];
      const allActions: string[] = [];
      for (const p of Object.values(policies)) {
        const statements = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
          .Properties?.PolicyDocument?.Statement;
        for (const s of statements ?? []) {
          const action = (s as { Action?: string | string[] }).Action;
          if (Array.isArray(action)) allActions.push(...action);
          else if (typeof action === "string") allActions.push(action);
        }
      }
      for (const w of writeActions) {
        expect(allActions).not.toContain(w);
      }
      // 同時に read action は最低 1 つ (Query / GetItem) 含むこと。
      expect(allActions.some((a) => a === "dynamodb:Query" || a === "dynamodb:GetItem")).toBe(true);
    });
  });

  describe("Outputs", () => {
    it("AdminInsightApiUrl を Output として出すべき", () => {
      const tpl = synthInsightStack();
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toContain("AdminInsightApiUrl");
    });
  });
});
