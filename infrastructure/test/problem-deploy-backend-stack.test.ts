import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

const FAKE_BUS_ARN = "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus";

function synth(
  overrides?: Partial<ConstructorParameters<typeof ProblemDeployBackendStack>[2]>,
): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    eventBusArn: FAKE_BUS_ARN,
    deployExternalId: "ext-test",
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack", () => {
  describe("instantiate したとき", () => {
    it("Deployments テーブルを 1 つ作るべき", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::DynamoDB::Table", 1);
    });

    it("Deployments テーブルは PROVISIONED 1/1 で PK/SK を持つべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          BillingMode: Match.absent(),
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          KeySchema: Match.arrayWith([
            Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
            Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
          ]),
        }),
      );
    });

    it("Deployments テーブルは GSI1 を持ち、PROVISIONED 1/1 であるべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          GlobalSecondaryIndexes: Match.arrayWith([
            Match.objectLike({
              IndexName: "GSI1",
              KeySchema: Match.arrayWith([
                Match.objectLike({ AttributeName: "GSI1PK", KeyType: "HASH" }),
                Match.objectLike({ AttributeName: "GSI1SK", KeyType: "RANGE" }),
              ]),
              ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
            }),
          ]),
        }),
      );
    });

    it("Deployments テーブルは expiresAt の TTL を持つべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        }),
      );
    });

    it("Deployments テーブルは Retain で削除耐性を持つべき", () => {
      const tpl = synth();
      tpl.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
    });

    it("DeployWorkerRole は lambda.amazonaws.com に assume させるべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          AssumeRolePolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              }),
            ]),
          }),
        }),
      );
    });

    it("DeployWorkerRole は競技者 Role を AssumeRole できる inline policy を持つべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          Policies: Match.arrayWith([
            Match.objectLike({
              PolicyName: "AssumeCompetitorRoles",
              PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                  Match.objectLike({
                    Effect: "Allow",
                    Action: "sts:AssumeRole",
                    Resource: "arn:aws:iam::*:role/TenkaCloud-CompetitorDeploy-Role",
                  }),
                ]),
              }),
            }),
          ]),
        }),
      );
    });

    it("DeployWorkerRole は Deployments への CRUD inline policy を持つべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          Policies: Match.arrayWith([
            Match.objectLike({
              PolicyName: "DeploymentsTableAccess",
              PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                  Match.objectLike({
                    Effect: "Allow",
                    Action: Match.arrayWith([
                      "dynamodb:GetItem",
                      "dynamodb:PutItem",
                      "dynamodb:UpdateItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:Query",
                    ]),
                  }),
                ]),
              }),
            }),
          ]),
        }),
      );
    });

    it("DeployWorkerRole は EventBus PutEvents inline policy を持ち、Resource は与えた arn 限定であるべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          Policies: Match.arrayWith([
            Match.objectLike({
              PolicyName: "EventBusPublish",
              PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                  Match.objectLike({
                    Effect: "Allow",
                    Action: "events:PutEvents",
                    Resource: FAKE_BUS_ARN,
                  }),
                ]),
              }),
            }),
          ]),
        }),
      );
    });

    it("Outputs に DeploymentsTableName と DeployWorkerRoleArn を含むべき", () => {
      const tpl = synth();
      tpl.hasOutput("DeploymentsTableName", {});
      tpl.hasOutput("DeployWorkerRoleArn", {});
      tpl.hasOutput("DeployApiUrl", {});
    });

    it("Deploy API Lambda を 1 つ作るべき (Node.js 20 / arm64)", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Handler: "index.handler",
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              DEPLOY_EVENT_BUS_NAME: Match.anyValue(),
            }),
          }),
        }),
      );
    });

    it("Deploy API Lambda の Function URL は AWS_IAM 認証であるべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Lambda::Url",
        Match.objectLike({
          AuthType: "AWS_IAM",
        }),
      );
    });

    it("Deploy API Lambda は DeployWorkerRole を execution role として再利用するべき", () => {
      const tpl = synth();
      // Worker Role は inlinePolicies で DDB / EventBridge / AssumeRole 権限を持つ。
      // Lambda は自動生成 role を作らず Worker Role を流用するので、追加の AWS::IAM::Policy
      // (DDB Put 権限のみの reduced policy) は新規作成されない。
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          Policies: Match.arrayWith([
            Match.objectLike({
              PolicyName: "DeploymentsTableAccess",
              PolicyDocument: Match.objectLike({
                Statement: Match.arrayWith([
                  Match.objectLike({
                    Effect: "Allow",
                    Action: Match.arrayWith(["dynamodb:PutItem"]),
                  }),
                ]),
              }),
            }),
          ]),
        }),
      );
    });
  });

  describe("DeployWorkerLambda + EventBridge Rule", () => {
    it("Lambda 関数を 3 つ作るべき (API + Worker + StatusUpdater)", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::Lambda::Function", 3);
    });

    it("Worker Lambda は DEPLOY_EXTERNAL_ID を env として持つべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOY_EXTERNAL_ID: "ext-test",
              COMPETITOR_ROLE_NAME: "TenkaCloud-CompetitorDeploy-Role",
            }),
          }),
        }),
      );
    });

    it("EventBridge Rule で tenkacloud.problem / DeployRequested を target にすべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.problem"],
            "detail-type": ["DeployRequested"],
          }),
        }),
      );
    });

    it("StatusUpdater には rate(1 minute) の schedule rule を立てるべき", () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          ScheduleExpression: "rate(1 minute)",
        }),
      );
    });
  });

  describe("HTTP API + Cognito JWT authorizer", () => {
    it("deployApiCognito 未指定なら HTTP API は作らないべき", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
      tpl.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 0);
    });

    it("deployApiCognito 指定で HTTP API + JWT authorizer を作るべき", () => {
      const tpl = synth({
        deployApiCognito: {
          userPoolId: "ap-northeast-1_TESTPOOL",
          clientId: "test-client-id",
        },
        deployApiCorsOrigins: ["http://localhost:5173"],
      });
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Authorizer",
        Match.objectLike({
          AuthorizerType: "JWT",
          IdentitySource: ["$request.header.Authorization"],
          JwtConfiguration: Match.objectLike({
            Audience: ["test-client-id"],
            Issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TESTPOOL",
          }),
        }),
      );
    });

    it("HTTP API は POST /deploy / GET /deployments / GET /deployments/:jobId のルートを持つべき", () => {
      const tpl = synth({
        deployApiCognito: { userPoolId: "ap-northeast-1_X", clientId: "c-1" },
      });
      const expectedRoutes = [
        "POST /problems/{problemId}/deploy",
        "GET /problems/{problemId}/deployments",
        "GET /deployments/{jobId}",
      ];
      for (const routeKey of expectedRoutes) {
        tpl.hasResourceProperties(
          "AWS::ApiGatewayV2::Route",
          Match.objectLike({ RouteKey: routeKey, AuthorizationType: "JWT" }),
        );
      }
    });

    it("CORS allowOrigins は指定値を反映するべき", () => {
      const tpl = synth({
        deployApiCognito: { userPoolId: "ap-northeast-1_X", clientId: "c-1" },
        deployApiCorsOrigins: ["http://localhost:5173", "https://example.com"],
      });
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Api",
        Match.objectLike({
          CorsConfiguration: Match.objectLike({
            AllowOrigins: ["http://localhost:5173", "https://example.com"],
          }),
        }),
      );
    });
  });

  describe("複数 stack を同居しても", () => {
    it("synth が衝突なく通るべき (ResourceName 自動生成)", () => {
      const app = new cdk.App();
      const a = new ProblemDeployBackendStack(app, "A", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        eventBusArn: FAKE_BUS_ARN,
        deployExternalId: "ext-a",
      });
      const b = new ProblemDeployBackendStack(app, "B", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        eventBusArn: FAKE_BUS_ARN,
        deployExternalId: "ext-b",
      });
      expect(() => Template.fromStack(a)).not.toThrow();
      expect(() => Template.fromStack(b)).not.toThrow();
    });
  });
});
