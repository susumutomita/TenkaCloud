import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Project, Source } from "aws-cdk-lib/aws-codebuild";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { DeployDeleteStateMachine } from "../../lib/problem-deploy/deploy-delete-state-machine";

/**
 * Issue #1797: イベント削除後に競技者 CFn スタックが残存する regression の機械検査。
 *
 * delete CodeBuild が「stack の存在しない account」への credentials で走ると、
 * `delete-stack` は no-op 成功 → `wait` も成功 → DB は DELETED なのに実 stack が残る
 * silent leak になる。State Machine は deployment 行の `awsAccountId` を
 * `DELETE_EXPECTED_AWS_ACCOUNT_ID` として CodeBuild に渡し、`delete-battles.sh` が
 * `sts get-caller-identity` と突き合わせて mismatch を loud fail させる。
 */

/** The stack scaffolding (deployments table + CodeBuild project) shared by every case, without the
 *  state machine — so the error case can reuse it instead of re-building the boilerplate. */
function buildBareStack(): {
  stack: cdk.Stack;
  deployments: Table;
  codeBuildProject: Project;
} {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const deployments = new Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
  });
  const codeBuildProject = new Project(stack, "CodeBuild", {
    source: Source.s3({
      bucket: cdk.aws_s3.Bucket.fromBucketName(stack, "Src", "test-source-bucket"),
      path: "source.zip",
    }),
  });
  return { stack, deployments, codeBuildProject };
}

function buildTestStack(opts: { deployViaLambda?: boolean } = {}): {
  stack: cdk.Stack;
  template: Template;
} {
  const { stack, deployments, codeBuildProject } = buildBareStack();
  // Only stub the shared CfnDeployLambda when the flag is ON, so the flag-OFF stack stays
  // Lambda-free (= the byte-compat resource-count assertion below is meaningful).
  const lambdaProps = opts.deployViaLambda
    ? {
        deployViaLambda: true as const,
        cfnDeployFunction: new LambdaFunction(stack, "CfnDeployFn", {
          runtime: Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: Code.fromInline("exports.handler = async () => ({});"),
        }),
      }
    : {};
  new DeployDeleteStateMachine(stack, "Sm", {
    codeBuildProject,
    deploymentsTable: deployments,
    ...lambdaProps,
  });
  return { stack, template: Template.fromStack(stack) };
}

/**
 * DefinitionString は CFn が Fn::Join で組み立てる可能性があるので、join components を
 * 結合して 1 string にする (ref は ARN placeholder で十分)。
 */
function extractDefinition(template: Template): string {
  const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
  const sm = Object.values(stateMachines)[0];
  expect(sm).toBeDefined();
  const definitionString = sm?.Properties?.DefinitionString;
  expect(definitionString).toBeDefined();
  if (typeof definitionString === "string") return definitionString;
  const join = definitionString["Fn::Join"];
  const parts = join[1] as Array<string | Record<string, unknown>>;
  return parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
}

describe("DeployDeleteStateMachine expected-account wiring (#1797)", () => {
  it("should forward the deployment row awsAccountId to both delete CodeBuild routes", () => {
    const { template } = buildTestStack();
    const asl = extractDefinition(template);

    // same-account / cross-account の両 StartDeleteCodeBuild state が
    // DELETE_EXPECTED_AWS_ACCOUNT_ID を $.detail.awsAccountId から渡す。
    const nameCount = asl.split('"Name":"DELETE_EXPECTED_AWS_ACCOUNT_ID"').length - 1;
    expect(nameCount).toBe(2);
    const valueCount = asl.split('"Value.$":"$.detail.awsAccountId"').length - 1;
    expect(valueCount).toBe(2);
  });

  it("should keep the cross-account route gated on competitorRoleArn + externalIdParameterName both present", () => {
    const { template } = buildTestStack();
    const asl = extractDefinition(template);

    // ルーティング条件は #1797 調査の前提 (deploy と delete の routing 対称性)。
    // 片方だけ存在する壊れた metadata は CodeBuild に到達させず markFailed へ。
    expect(asl).toContain('"Variable":"$.detail.competitorRoleArn"');
    expect(asl).toContain('"Variable":"$.detail.externalIdParameterName"');
    expect(asl).toContain("InvalidAssumeRoleMetadata");
  });

  it("should route events missing awsAccountId to markFailed instead of an uncatchable States.Runtime", () => {
    const { template } = buildTestStack();
    const asl = extractDefinition(template);

    // 両 CodeBuild state が $.detail.awsAccountId を JsonPath 参照するため、欠損 event を
    // CodeBuild state に流すと States.Runtime (= addCatch 捕捉不能) で execution が死に、
    // 行が DELETING のまま stuck する。両 when 条件の isPresent ガードを pin する。
    const guardCount = asl.split('"Variable":"$.detail.awsAccountId"').length - 1;
    expect(guardCount).toBe(2);
    expect(asl).toContain("detail must include awsAccountId");
  });
});

/**
 * Issue #2291: deployViaLambda feature flag. Flag OFF keeps the CodeBuild `.sync`
 * definition unchanged (byte-compat: zero new resources); flag ON swaps to the Lambda DeleteStack +
 * DescribeStacks poll definition (reusing the create path's shared CfnDeployLambda).
 */
describe("DeployDeleteStateMachine deployViaLambda flag (#2291)", () => {
  it("should keep the CodeBuild StartBuild task when the flag is OFF (default, unchanged)", () => {
    const asl = extractDefinition(buildTestStack().template);
    expect(asl).toContain("startBuild.sync");
    expect(asl).toContain('"StartDeleteCodeBuild"');
    // Lambda 経路の state は現れない (= 追加リソースなし)。
    expect(asl).not.toContain('"InvokeCfnDelete"');
    expect(asl).not.toContain('"WaitBeforePoll"');
    expect(asl).not.toContain('"DescribeDeleteStatus"');
  });

  it("should add ZERO new Lambda / role resources when the flag is OFF (byte-compat)", () => {
    // The CodeBuild-mode delete SM stands up no Lambda of its own — the only IAM roles are the
    // pre-existing CodeBuild + StateMachine roles. A Lambda appearing here would prove the default
    // path grew a resource (violating the slice-1 byte-compat promise).
    const { template } = buildTestStack();
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  });

  it("should invoke the deploy Lambda + DescribeStacks poll loop when the flag is ON", () => {
    const asl = extractDefinition(buildTestStack({ deployViaLambda: true }).template);
    expect(asl).toContain('"InvokeCfnDelete"');
    expect(asl).toContain('"WaitBeforePoll"');
    expect(asl).toContain('"DescribeDeleteStatus"');
    expect(asl).toContain('"RoutePollStatus"');
    // terminal 判定 (success / failure) が poll Choice にある。
    expect(asl).toContain("DELETE_COMPLETE");
    expect(asl).toContain("DELETE_FAILED");
    // create / delete を index.ts で分岐する action field を渡す。
    expect(asl).toContain('"action":"delete"');
    expect(asl).toContain('"action":"describe-delete"');
    // CodeBuild は Lambda 経路では使われない。
    expect(asl).not.toContain("startBuild.sync");
    expect(asl).not.toContain('"StartDeleteCodeBuild"');
  });

  it("should still write the same DELETED / FAILED DDB status transitions in the Lambda branch", () => {
    const asl = extractDefinition(buildTestStack({ deployViaLambda: true }).template);
    // Match the quoted DDB status values (not bare substrings, which could hit incidental text).
    expect(asl).toContain('"DELETED"');
    expect(asl).toContain('"FAILED"');
    // Lambda 経路は buildId を書かない (= CodeBuild 固有; MarkDeleted / MarkFailed は元から非依存)。
    expect(asl).not.toContain("codebuild.Build.Id");
  });

  it("should require cfnDeployFunction when deployViaLambda is true", () => {
    const { stack, deployments, codeBuildProject } = buildBareStack();
    expect(
      () =>
        new DeployDeleteStateMachine(stack, "Sm", {
          codeBuildProject,
          deploymentsTable: deployments,
          deployViaLambda: true,
        }),
    ).toThrow(/cfnDeployFunction is required/);
  });

  it("should require codeBuildProject on the default CodeBuild path", () => {
    const { stack, deployments } = buildBareStack();
    expect(
      () =>
        new DeployDeleteStateMachine(stack, "Sm", {
          deploymentsTable: deployments,
        }),
    ).toThrow(/codeBuildProject is required/);
  });
});
