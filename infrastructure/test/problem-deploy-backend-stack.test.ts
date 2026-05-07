import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

// 全 it() で同じ Template を使い回す。stack 構造は default props で固定なので、
// describe ブロック単位で 1 度 synth すれば 13 回 → 1 回に圧縮できる。
function synthDefault(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsScoring: {},
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack (MVP-1)", () => {
  const tpl = synthDefault();

  describe("Deployments DDB table", () => {
    it("DDB テーブルを 1 つ持ち、PK/SK + PROVISIONED 1/1 であるべき", () => {
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
      tpl.hasResourceProperties(
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
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              BATTLE_PROBLEMS_CATALOG: JSON.stringify({
                "hello-world": "problems/challenges/hello-world",
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("CodeBuild Project (deploy-battles.sh を実行)", () => {
    it("CodeBuild Project を 1 つ作るべき", () => {
      tpl.resourceCountIs("AWS::CodeBuild::Project", 1);
    });

    it("CodeBuild は S3 source を読むべき", () => {
      tpl.hasResourceProperties(
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
    it("Create / Delete の State Machine を 2 つ作るべき", () => {
      tpl.resourceCountIs("AWS::StepFunctions::StateMachine", 2);
    });

    it("EventBridge Rule を Create / Delete でそれぞれ 1 つずつ持つべき", () => {
      tpl.resourceCountIs("AWS::Events::Rule", 2);
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.deploy"],
            "detail-type": ["DeployCreateRequested"],
          }),
        }),
      );
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.deploy"],
            "detail-type": ["DeployDeleteRequested"],
          }),
        }),
      );
    });
  });

  describe("Outputs", () => {
    it("DeploymentsTableName と DeployCreateStateMachineArn を Output として持つべき", () => {
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toEqual(
        expect.arrayContaining(["DeploymentsTableName", "DeployCreateStateMachineArn"]),
      );
    });
  });

  describe("legacy 経路の廃止", () => {
    it("旧 DeployApiGateway (HTTP API) を作らないべき", () => {
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    });
  });
});
