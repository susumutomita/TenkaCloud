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
    it("should provision 1 AdminInsight Lambda on Node.js 22 / arm64", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::Lambda::Function", 1);
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
        }),
      );
    });

    it("should pass Deployments / Events / Teams table names to Lambda env", () => {
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
    it("should have 1 HTTP API (API GW v2)", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    });

    it("should have a JWT Authorizer (linked to Cognito UserPool)", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Authorizer",
        Match.objectLike({
          AuthorizerType: "JWT",
          IdentitySource: ["$request.header.Authorization"],
        }),
      );
    });

    it("GET /admin/insight/tenants/summary route should be wired to the JWT Authorizer", () => {
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

    it("should have the 4 Phase 1.B drill-down routes (events / event detail / deployment / stack-progress)", () => {
      const tpl = synthInsightStack();
      const expected = [
        "GET /admin/insight/tenants/{tenantId}/events",
        "GET /admin/insight/tenants/{tenantId}/events/{eventId}",
        "GET /admin/insight/tenants/{tenantId}/deployments/{jobId}",
        "GET /admin/insight/tenants/{tenantId}/deployments/{jobId}/stack-progress",
      ];
      for (const routeKey of expected) {
        const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
          Properties: { RouteKey: routeKey },
        });
        expect(Object.keys(routes), `route ${routeKey} should exist`).toHaveLength(1);
        const route = Object.values(routes)[0] as {
          Properties: { AuthorizationType: string };
        };
        expect(route.Properties.AuthorizationType).toBe("JWT");
      }
    });

    it("should include localhost dev in CORS allowOrigins", () => {
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

    it("should add adminConsoleOrigin (equivalent to CDK_PARAM_ADMIN_CONSOLE_ORIGIN) to CORS", () => {
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
    function collectActions(tpl: Template): string[] {
      const policies = tpl.findResources("AWS::IAM::Policy");
      return Object.values(policies).flatMap(policyActions);
    }

    function policyActions(policy: unknown): string[] {
      const statements = (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
        .Properties?.PolicyDocument?.Statement;
      return (statements ?? []).flatMap(statementActions);
    }

    function statementActions(statement: unknown): string[] {
      const action = (statement as { Action?: string | string[] }).Action;
      if (Array.isArray(action)) return action;
      return typeof action === "string" ? [action] : [];
    }

    it("should Allow only reads on Deployments / Events / Teams tables (no writes)", () => {
      const tpl = synthInsightStack();
      // Lambda role に attach された IAM Policy の中に DynamoDB write action が無いことを
      // 強めに検証する (= 旧 grantReadWriteData で誤 wire したら test が落ちる)。
      const writeActions = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];
      const allActions = collectActions(tpl);
      for (const w of writeActions) {
        expect(allActions).not.toContain(w);
      }
      // 同時に read action は最低 1 つ (Query / GetItem) 含むこと。
      expect(allActions.some((a) => a === "dynamodb:Query" || a === "dynamodb:GetItem")).toBe(true);
    });

    it("Phase 1.B: should grant Teams-table read (#598)", () => {
      const tpl = synthInsightStack();
      // Teams は Phase 1.A では env 注入のみだったが、Phase 1.B drill-down で read 権限を
      // 追加する。Policy が Teams table の ARN を参照する Statement を 1 つ以上持つこと。
      const policies = tpl.findResources("AWS::IAM::Policy");
      const policyJsonAll = JSON.stringify(policies);
      // CDK は Table.tableArn を Fn::GetAtt で参照するので、policy JSON 内に Teams<HashSuffix>
      // / TeamsResource 等のリソース名が含まれる。tableName よりも logicalId で固定。
      expect(policyJsonAll).toContain("Teams");
    });

    it("Phase 1.B: should grant CFn DescribeStackEvents / DescribeStackResources (#598)", () => {
      const tpl = synthInsightStack();
      const allActions = collectActions(tpl);
      expect(allActions).toContain("cloudformation:DescribeStackEvents");
      expect(allActions).toContain("cloudformation:DescribeStackResources");
    });
  });

  describe("#1392: dead system-users routes + unused Cognito Admin* IAM removed", () => {
    it("should NOT register any /admin/insight/system-users route (handler was removed)", () => {
      const tpl = synthInsightStack();
      tpl.resourcePropertiesCountIs(
        "AWS::ApiGatewayV2::Route",
        { RouteKey: Match.stringLikeRegexp("system-users") },
        0,
      );
    });

    it("should NOT grant cognito-idp:Admin* on any IAM policy (no standing privilege)", () => {
      const tpl = synthInsightStack();
      tpl.resourcePropertiesCountIs(
        "AWS::IAM::Policy",
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(["cognito-idp:AdminCreateUser"]),
              }),
            ]),
          },
        },
        0,
      );
    });
  });

  describe("Outputs", () => {
    it("should expose AdminInsightApiUrl as a stack Output", () => {
      const tpl = synthInsightStack();
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toContain("AdminInsightApiUrl");
    });
  });
});
