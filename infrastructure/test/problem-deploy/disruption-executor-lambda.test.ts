import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import { describe, expect, it } from "vitest";
import { DisruptionExecutorLambda } from "../../lib/problem-deploy/disruption-executor-lambda";

/**
 * [ADR-031 / #1419] cross-account disruption executor の CDK 境界を pin する。 核心は
 * 「自前 role は最小 (sts:AssumeRole は TenkaCloud-* のみ、 SendCommand/Invoke/UpdateStack は **持たない**)」
 * = 破壊力は assumed の CompetitorDeployRole に閉じ、 executor 自身の blast radius は IAM で封じる。
 */

const SYNTH_TIMEOUT_MS = 120_000;

function synth(): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  const deployments = new Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
  });
  const disruptions = new Table(stack, "Disruptions", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
  });
  new DisruptionExecutorLambda(stack, "Executor", {
    environmentName: "development",
    eventBus: new EventBus(stack, "Bus"),
    deploymentsTable: deployments,
    disruptionsTable: disruptions,
    problemsDisruptions: { "microservice-migration-battle": [{ id: "x" }] },
  });
  return Template.fromStack(stack);
}

/** 全 IAM Role の inline policy (= 権限境界。 trust policy は除外) の action を集める。 */
function inlineActions(tpl: Template): string[] {
  return Object.values(tpl.findResources("AWS::IAM::Policy")).flatMap((p) =>
    (
      (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
        ?.PolicyDocument?.Statement ?? []
    ).flatMap((s) => {
      const a = (s as { Action?: string | string[] }).Action;
      return Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
    }),
  );
}

describe("DisruptionExecutorLambda (ADR-031 #1419)", () => {
  it(
    "should provision a Node.js / arm64 executor Lambda with the wiring env",
    () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              DISRUPTIONS_TABLE_NAME: Match.anyValue(),
              REVERT_SCHEDULER_ROLE_ARN: Match.anyValue(),
              EXECUTOR_FUNCTION_ARN: Match.anyValue(),
            }),
          }),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should scope sts:AssumeRole to TenkaCloud-* roles (not a wildcard)",
    () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: "sts:AssumeRole",
                Resource: "arn:aws:iam::*:role/TenkaCloud-*",
              }),
            ]),
          }),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should NOT grant the executor's own role the destructive cross-account actions (they ride the assumed role)",
    () => {
      const actions = inlineActions(synth());
      // 注入/復旧の破壊操作は assumed CompetitorDeployRole 経由。 executor 自身の role には付けない。
      expect(actions).not.toContain("ssm:SendCommand");
      expect(actions).not.toContain("lambda:InvokeFunction"); // 自前 role には無い (= scheduler role 側のみ)
      expect(actions).not.toContain("cloudformation:UpdateStack");
      // 最小権限は揃っている。
      expect(actions).toContain("dynamodb:Query");
      expect(actions).toContain("dynamodb:PutItem");
      expect(actions).toContain("scheduler:CreateSchedule");
      expect(actions).toContain("iam:PassRole");
      expect(actions).toContain("ssm:GetParameter");
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "should route tenkacloud.disruptions events to the executor and provision a scheduler-assumable revert role",
    () => {
      const tpl = synth();
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({ EventPattern: { source: ["tenkacloud.disruptions"] } }),
      );
      // revert scheduler role: scheduler.amazonaws.com が assume + lambda:InvokeFunction を持つ。
      tpl.hasResourceProperties(
        "AWS::IAM::Role",
        Match.objectLike({
          AssumeRolePolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Principal: { Service: "scheduler.amazonaws.com" },
              }),
            ]),
          }),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );
});
