import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Project, Source } from "aws-cdk-lib/aws-codebuild";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
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

function buildTestStack(): { stack: cdk.Stack; template: Template } {
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
  new DeployDeleteStateMachine(stack, "Sm", {
    codeBuildProject,
    deploymentsTable: deployments,
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
