import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Project, Source } from "aws-cdk-lib/aws-codebuild";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { DeployCreateStateMachine } from "../../lib/problem-deploy/deploy-create-state-machine";

/**
 * Issue #809: DescribeStack task の Parameters が JSONPath-resolved object になることを
 * 機械検査する regression test。
 *
 * 旧コード (= `TaskInput.fromJsonPathAt("$")` + `payloadResponseOnly: true`) は ASL で
 * `Parameters: "$"` (= literal string) を生成し、 Lambda が literal `"$"` を event として
 * 受け取って `event.detail.jobId` undefined で fail していた。
 *
 * 修正後は `TaskInput.fromObject({ detail: JsonPath.objectAt("$.detail") })` を使い、
 * ASL で `Parameters: { "detail.$": "$.detail" }` を生成する (= Step Functions が
 * JSONPath を resolve して Lambda に渡す)。
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
  const describeStackFn = new LambdaFunction(stack, "DescribeStackFn", {
    runtime: Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
  const codeBuildProject = new Project(stack, "CodeBuild", {
    source: Source.s3({
      bucket: cdk.aws_s3.Bucket.fromBucketName(stack, "Src", "test-source-bucket"),
      path: "source.zip",
    }),
  });
  new DeployCreateStateMachine(stack, "Sm", {
    codeBuildProject,
    describeStackFunction: describeStackFn,
    deploymentsTable: deployments,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("DeployCreateStateMachine DescribeStack task (#809 regression)", () => {
  it("DescribeStack task の Parameters は object であり、 literal string ではないべき", () => {
    const { template } = buildTestStack();
    const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
    const sm = Object.values(stateMachines)[0];
    expect(sm).toBeDefined();
    const definitionString = sm?.Properties?.DefinitionString;
    expect(definitionString).toBeDefined();

    // DefinitionString は CFn が join で組み立てるので {"Fn::Join": [...]} の可能性あり。
    // join の場合は components を結合して 1 string にして JSON parse 可能性を確認する。
    let asJson: string;
    if (typeof definitionString === "string") {
      asJson = definitionString;
    } else {
      // Fn::Join 形式: ["", [strings/refs]]。 ref は arn の placeholder なので string concat で OK。
      const join = definitionString["Fn::Join"];
      const parts = join[1] as Array<string | Record<string, unknown>>;
      asJson = parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
    }

    // DescribeStack task definition を抽出。
    // 旧 bug 形式: `"Parameters":"$"`
    // 修正後形式: `"Parameters":{"detail.$":"$.detail"}`
    expect(asJson).not.toContain('"Parameters":"$"');
    expect(asJson).toContain('"DescribeStack"');
    expect(asJson).toContain('"detail.$":"$.detail"');
  });

  it("DescribeStack task は payloadResponseOnly=true 維持で resultPath が $.cfn であるべき", () => {
    const { template } = buildTestStack();
    const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
    const sm = Object.values(stateMachines)[0];
    const definitionString = sm?.Properties?.DefinitionString;
    let asJson: string;
    if (typeof definitionString === "string") {
      asJson = definitionString;
    } else {
      const join = definitionString["Fn::Join"];
      const parts = join[1] as Array<string | Record<string, unknown>>;
      asJson = parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
    }
    // resultPath: "$.cfn" は ASL 上 "ResultPath":"$.cfn" として出る。
    expect(asJson).toContain('"ResultPath":"$.cfn"');
  });

  it("StateMachine 全体が synth 可能で IAM policy で Lambda invoke が許可されるべき", () => {
    const { template } = buildTestStack();
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    // State Machine の execution role policy が Lambda invoke を含むこと
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "lambda:InvokeFunction",
            }),
          ]),
        }),
      }),
    );
  });

  // Issue #895 Phase 2.A: ADR-001 §6 の stack tagging に必要な tenantId / jobId を
  // CodeBuild env に渡す経路の regression test。 これらが欠けると deploy-battles.sh が
  // tag 値を \"unknown\" にして CFn → tenant 逆引きが効かなくなる。
  it("Issue #895: CodeBuild env に TENKACLOUD_TENANT_ID / TENKACLOUD_JOB_ID が渡されるべき", () => {
    const { template } = buildTestStack();
    const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
    const sm = Object.values(stateMachines)[0];
    const definitionString = sm?.Properties?.DefinitionString;
    let asJson: string;
    if (typeof definitionString === "string") {
      asJson = definitionString;
    } else {
      const join = definitionString["Fn::Join"];
      const parts = join[1] as Array<string | Record<string, unknown>>;
      asJson = parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
    }
    // ASL 上 EnvironmentVariablesOverride は `Name / Type / Value.$` 形式。
    expect(asJson).toContain('"Name":"TENKACLOUD_TENANT_ID"');
    expect(asJson).toContain('"Value.$":"$.detail.tenantId"');
    expect(asJson).toContain('"Name":"TENKACLOUD_JOB_ID"');
    // 既存 TENKACLOUD_CORRELATION_ID と PROBLEM_EXTERNAL_ID も維持されているべき (regression 防止)
    expect(asJson).toContain('"Name":"TENKACLOUD_CORRELATION_ID"');
    expect(asJson).toContain('"Name":"PROBLEM_EXTERNAL_ID"');
  });
});
