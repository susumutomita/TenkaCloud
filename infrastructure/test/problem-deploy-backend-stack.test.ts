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
    it("DDB テーブルを Deployments / Events / Teams の 3 つ持ち、各 PK/SK + PROVISIONED 1/1 であるべき", () => {
      // ADR-004 Phase 1 で Events / Teams を追加。3 Table すべて DynamoDbLowCapacity Aspect で
      // 1/1 PROVISIONED に均される。
      tpl.resourceCountIs("AWS::DynamoDB::Table", 3);
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

    it("Create State Machine は CodeBuild 起動前に PENDING → IN_PROGRESS の中間遷移を書くべき", () => {
      // RUN_JOB 同期 CodeBuild は 5〜15 分かかるため、この中間書込が無いと operator UI が
      // PENDING のまま固定して polling が機能していないように見える (#159 の再発防止)。
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const synthJson = JSON.stringify(stateMachines);
      expect(synthJson).toContain("MarkInProgress");
      expect(synthJson).toContain("IN_PROGRESS");
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

/**
 * ParticipantPortalLambda を含む synth (= participantPortal prop あり)。
 * EVENTS_TABLE_NAME 配線 + Events table への Query IAM 付与を assert する。
 */
function synthWithParticipantPortal(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsScoring: {},
    participantPortal: { runtimeConfig: "default-dev-mock" },
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack — ParticipantPortalLambda wiring (#535)", () => {
  const tpl = synthWithParticipantPortal();

  it("ParticipantPortal Lambda の environment に EVENTS_TABLE_NAME が設定されるべき", () => {
    // ADR-006 Notifications backend (PR-524) が Module load 時に EVENTS_TABLE_NAME を
    // 必須で読むので、CDK 配線が無いと Lambda init で throw して portal 全 route が
    // 502 になる (= #535 regression)。本 assertion で再発防止。
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
            EVENTS_TABLE_NAME: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it("ParticipantPortal Lambda の IAM Role に Events table の dynamodb:Query を付与するべき", () => {
    // ADR-006: GET /portal/me/notifications が Events table を Query する。
    // 配線が無いと AccessDenied で 500 になる。Role 直貼りの inline policy なので
    // `AWS::IAM::Role` の Policies 配列を見る。
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "EventsRead",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: "dynamodb:Query",
                  Effect: "Allow",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });
});
