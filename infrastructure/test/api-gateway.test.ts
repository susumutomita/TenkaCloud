import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiGateway } from "../lib/tenant-template/api-gateway";

/**
 * ApiGateway construct の AuthProxyAsset は apps/auth-proxy/dist/lambda を参照するが、
 * CI / ローカル test 時に未 build のことがある。synth は Asset path 存在を検証するので
 * placeholder を beforeAll で作る。実 bun build が走るとそれで上書きされる。
 */
const authProxyDistDir = path.join(__dirname, "..", "..", "apps", "auth-proxy", "dist", "lambda");

function ensureAuthProxyPlaceholder() {
  if (!fs.existsSync(authProxyDistDir)) {
    fs.mkdirSync(authProxyDistDir, { recursive: true });
    fs.writeFileSync(
      path.join(authProxyDistDir, "lambda.js"),
      "exports.handler = async () => ({ statusCode: 200, body: 'placeholder' });\n",
    );
  }
}

function dummyApiKey() {
  return { apiKeyId: "stub-key-id", value: "stub-value" };
}

interface SynthOverrides {
  brokerEntraGraphParameterName?: string;
  appsTableBillingMode?: BillingMode;
  appsTableReadCapacity?: number;
  appsTableWriteCapacity?: number;
}

function synth(tenantId: string, overrides: SynthOverrides = {}): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const userPool = new UserPool(stack, "TestUserPool");
  const userPoolClient = new UserPoolClient(stack, "TestUserPoolClient", { userPool });
  const billingMode = overrides.appsTableBillingMode ?? BillingMode.PROVISIONED;
  new ApiGateway(stack, "ApiGw", {
    tenantId,
    isPooledDeploy: false,
    idpDetails: { name: "Cognito", details: {} },
    userPool,
    userPoolClient,
    cognitoDomainUrl: "https://TenkaCloud-app-tenant-1.auth.ap-northeast-1.amazoncognito.com",
    brokerEntra: overrides.brokerEntraGraphParameterName
      ? {
          graphParameterName: overrides.brokerEntraGraphParameterName,
          tenantConfigPrefix: "/TenkaCloud/tenants",
        }
      : undefined,
    appsTableBillingMode: billingMode,
    appsTableReadCapacity:
      billingMode === BillingMode.PROVISIONED ? (overrides.appsTableReadCapacity ?? 1) : undefined,
    appsTableWriteCapacity:
      billingMode === BillingMode.PROVISIONED ? (overrides.appsTableWriteCapacity ?? 1) : undefined,
    apiKeyBasicTier: dummyApiKey(),
    apiKeyStandardTier: dummyApiKey(),
    apiKeyPremiumTier: dummyApiKey(),
    apiKeyPlatinumTier: dummyApiKey(),
  });
  return Template.fromStack(stack);
}

describe("ApiGateway (#40-b / #40-c)", () => {
  beforeAll(() => {
    ensureAuthProxyPlaceholder();
  });

  describe("テナント ID と UserPool を渡してインスタンス化したとき", () => {
    it("Apps DynamoDB table (tenantId + appId composite key、provisioned 1/1、PITR 有効) を 1 つ作るべき", () => {
      const template = synth("tenant-1");
      template.resourceCountIs("AWS::DynamoDB::Table", 1);
      template.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          KeySchema: [
            { AttributeName: "tenantId", KeyType: "HASH" },
            { AttributeName: "appId", KeyType: "RANGE" },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      );
    });

    it("appsTableReadCapacity / appsTableWriteCapacity を override できるべき", () => {
      const template = synth("tenant-1", { appsTableReadCapacity: 5, appsTableWriteCapacity: 7 });
      template.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 7 },
        }),
      );
    });

    it("appsTableBillingMode = PAY_PER_REQUEST のとき capacity を持たない on-demand table を作るべき", () => {
      const template = synth("tenant-1", { appsTableBillingMode: BillingMode.PAY_PER_REQUEST });
      template.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          BillingMode: "PAY_PER_REQUEST",
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      );
      // PAY_PER_REQUEST table は ProvisionedThroughput を持たないこと
      const tables = template.findResources("AWS::DynamoDB::Table");
      const ddbProps = Object.values(tables)[0].Properties;
      expect(ddbProps.ProvisionedThroughput).toBeUndefined();
    });

    it("Cognito UserPools Authorizer を持つべき", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties(
        "AWS::ApiGateway::Authorizer",
        Match.objectLike({ Type: "COGNITO_USER_POOLS" }),
      );
    });

    it("/apps に POST / GET の 2 メソッドを持つべき (Authorizer 付き)", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties(
        "AWS::ApiGateway::Method",
        Match.objectLike({
          HttpMethod: "POST",
          AuthorizationType: "COGNITO_USER_POOLS",
        }),
      );
      template.hasResourceProperties(
        "AWS::ApiGateway::Method",
        Match.objectLike({
          HttpMethod: "GET",
          AuthorizationType: "COGNITO_USER_POOLS",
        }),
      );
    });

    it("/apps/{appId} に DELETE メソッドを持つべき (Authorizer 付き)", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties(
        "AWS::ApiGateway::Method",
        Match.objectLike({
          HttpMethod: "DELETE",
          AuthorizationType: "COGNITO_USER_POOLS",
        }),
      );
    });

    it("Apps API Lambda handler を 1 つ、per-app 共有 role を 1 つ作るべき", () => {
      const template = synth("tenant-1");
      // AppsApiHandler + (CustomResource 用 Lambda 含む場合あり) → 関数は少なくとも 1 つ
      const lambdas = template.findResources("AWS::Lambda::Function");
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(1);
      template.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs20.x",
          Handler: "index.handler",
          Environment: {
            Variables: Match.objectLike({
              APPS_TABLE: Match.anyValue(),
              AUTH_PROXY_BUCKET: Match.anyValue(),
              AUTH_PROXY_KEY: Match.anyValue(),
              PER_APP_LAMBDA_ROLE_ARN: Match.anyValue(),
              COGNITO_DOMAIN: Match.anyValue(),
              COGNITO_CLIENT_ID: Match.anyValue(),
              USER_POOL_ID: Match.anyValue(),
            }),
          },
        }),
      );
    });

    it("AppsApiHandler が Lambda CreateFunction / UpdateUserPoolClient 権限を持つべき", () => {
      const template = synth("tenant-1");
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(["lambda:CreateFunction"]),
                Effect: "Allow",
              }),
            ]),
          }),
        }),
      );
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(["cognito-idp:UpdateUserPoolClient"]),
                Effect: "Allow",
              }),
            ]),
          }),
        }),
      );
    });

    it("brokerEntraGraphParameterName があると Graph credential SSM parameter と Cognito IdP 操作権限を持つべき", () => {
      const template = synth("tenant-1", {
        brokerEntraGraphParameterName: "/TenkaCloud/broker-entra/graph-credentials",
      });
      template.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: {
            Variables: Match.objectLike({
              BROKER_ENTRA_GRAPH_PARAMETER_NAME: "/TenkaCloud/broker-entra/graph-credentials",
              BROKER_ENTRA_TENANT_CONFIG_PREFIX: "/TenkaCloud/tenants",
            }),
          },
        }),
      );
      template.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith([
                  "cognito-idp:CreateIdentityProvider",
                  "cognito-idp:UpdateIdentityProvider",
                ]),
                Effect: "Allow",
              }),
              Match.objectLike({
                Action: "ssm:GetParameter",
                Effect: "Allow",
                Resource: Match.arrayWith([
                  {
                    "Fn::Join": Match.arrayWith([
                      "",
                      Match.arrayWith([
                        "arn:",
                        { Ref: "AWS::Partition" },
                        ":ssm:ap-northeast-1:123456789012:parameter/TenkaCloud/broker-entra/*",
                      ]),
                    ]),
                  },
                ]),
              }),
            ]),
          }),
        }),
      );
    });
  });
});
