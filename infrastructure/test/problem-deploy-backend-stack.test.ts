import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

function synth(
  overrides: Partial<ConstructorParameters<typeof ProblemDeployBackendStack>[2]> = {},
): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/sample/hello-world",
    },
    ...overrides,
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack (MVP-1)", () => {
  describe("Deployments DDB table", () => {
    it("DDB テーブルを 1 つ持ち、PK/SK + PROVISIONED 1/1 であるべき", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::DynamoDB::Table", 1);
      // BillingMode は default (PROVISIONED) のとき CFn template に出力されないので、
      // ProvisionedThroughput と KeySchema で確認する。
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          ProvisionedThroughput: Match.objectLike({
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1,
          }),
          KeySchema: Match.arrayWith([
            Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
            Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
          ]),
        }),
      );
    });

    it("expiresAt の TTL を有効化すべき", () => {
      synth().hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          TimeToLiveSpecification: Match.objectLike({
            AttributeName: "expiresAt",
            Enabled: true,
          }),
        }),
      );
    });
  });

  describe("Deploy API Lambda (tenant API から invoke される)", () => {
    it("Node.js 20 / arm64 で BATTLE_PROBLEMS_CATALOG env を持つべき", () => {
      synth().hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              BATTLE_PROBLEMS_CATALOG: JSON.stringify({
                "hello-world": "problems/sample/hello-world",
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("CodeBuild Project (deploy-battles.sh を実行)", () => {
    it("CodeBuild Project を 1 つ作るべき", () => {
      synth().resourceCountIs("AWS::CodeBuild::Project", 1);
    });

    it("CodeBuild は S3 source を読むべき", () => {
      synth().hasResourceProperties(
        "AWS::CodeBuild::Project",
        Match.objectLike({
          Source: Match.objectLike({
            Type: "S3",
            Location: Match.stringLikeRegexp("test-source-bucket/source.zip"),
          }),
        }),
      );
    });
  });

  describe("Step Functions State Machine + EventBridge Rule", () => {
    it("State Machine を 1 つ作るべき", () => {
      synth().resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    });

    it("EventBridge Rule (DeployCreateRequested → State Machine) を 1 つ作るべき", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::Events::Rule", 1);
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.deploy"],
            "detail-type": ["DeployCreateRequested"],
          }),
        }),
      );
    });
  });

  describe("Outputs", () => {
    it("DeploymentsTableName と DeployCreateStateMachineArn を Output として持つべき", () => {
      const tpl = synth();
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toEqual(
        expect.arrayContaining(["DeploymentsTableName", "DeployCreateStateMachineArn"]),
      );
    });
  });

  describe("legacy 経路の廃止", () => {
    it("旧 DeployApiGateway (HTTP API) を作らないべき", () => {
      const tpl = synth();
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    });
  });
});
