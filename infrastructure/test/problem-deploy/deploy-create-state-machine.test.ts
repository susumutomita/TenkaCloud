import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Project, Source } from "aws-cdk-lib/aws-codebuild";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
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

function buildTestStack(opts: { deployViaLambda?: boolean; statusWriter?: boolean } = {}): {
  stack: cdk.Stack;
  template: Template;
} {
  const app = new cdk.App({ autoSynth: false });
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
  const cfnDeployFn = new LambdaFunction(stack, "CfnDeployFn", {
    runtime: Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
  const statusWriterFn = opts.statusWriter
    ? new LambdaFunction(stack, "StatusWriterFn", {
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromInline("exports.handler = async () => ({});"),
      })
    : undefined;
  // Issue #2291: Lambda path は失敗 event の PutEvents 先として EventBus が必須。
  const eventBus = new EventBus(stack, "Bus");
  new DeployCreateStateMachine(stack, "Sm", {
    codeBuildProject,
    describeStackFunction: describeStackFn,
    deploymentsTable: deployments,
    ...(opts.deployViaLambda
      ? { deployViaLambda: true as const, cfnDeployFunction: cfnDeployFn, eventBus }
      : {}),
    ...(statusWriterFn ? { statusWriterFunction: statusWriterFn } : {}),
  });
  return { stack, template: Template.fromStack(stack) };
}

function definitionJson(template: Template): string {
  const sm = Object.values(template.findResources("AWS::StepFunctions::StateMachine"))[0];
  const definitionString = sm?.Properties?.DefinitionString;
  if (typeof definitionString === "string") return definitionString;
  const join = definitionString["Fn::Join"];
  const parts = join[1] as Array<string | Record<string, unknown>>;
  return parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
}

describe("DeployCreateStateMachine DescribeStack task (#809 regression)", () => {
  it("DescribeStack task Parameters should be an object, not a literal string", () => {
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

  it("DescribeStack task should keep payloadResponseOnly=true with resultPath $.cfn", () => {
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

  it("the whole StateMachine should synth and the IAM policy should allow Lambda invoke", () => {
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

  // Issue #895: stack tagging に必要な tenantId / jobId を
  // CodeBuild env に渡す経路の regression test。 これらが欠けると deploy-battles.sh が
  // tag 値を \"unknown\" にして CFn → tenant 逆引きが効かなくなる。
  it("Issue #895: should pass TENKACLOUD_TENANT_ID / TENKACLOUD_JOB_ID into CodeBuild env", () => {
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

/**
 * Issue #2291: deployViaLambda feature flag. Flag OFF keeps the CodeBuild `.sync`
 * definition unchanged; flag ON swaps to the Lambda CreateStack + DescribeStacks poll definition.
 */
describe("DeployCreateStateMachine deployViaLambda flag (#2291)", () => {
  it("should keep the CodeBuild StartBuild task when the flag is OFF (default, unchanged)", () => {
    const asJson = definitionJson(buildTestStack().template);
    // CodeBuild `.sync` (RUN_JOB) 経路が定義に残っている。
    expect(asJson).toContain("startBuild.sync");
    expect(asJson).toContain('"StartDeployCodeBuild"');
    // Lambda 経路の state は現れない (= 追加リソースなし)。
    expect(asJson).not.toContain('"InvokeCfnDeploy"');
    expect(asJson).not.toContain('"WaitBeforePoll"');
  });

  it("should invoke the deploy Lambda + DescribeStack poll loop when the flag is ON", () => {
    const asJson = definitionJson(buildTestStack({ deployViaLambda: true }).template);
    // Lambda CreateStack + poll 経路。
    expect(asJson).toContain('"InvokeCfnDeploy"');
    expect(asJson).toContain('"WaitBeforePoll"');
    expect(asJson).toContain('"RoutePollStatus"');
    expect(asJson).toContain('"DescribeStack"');
    // terminal 判定 (success / failure) が poll Choice にある。
    expect(asJson).toContain("CREATE_COMPLETE");
    expect(asJson).toContain("ROLLBACK_COMPLETE");
    // CodeBuild は create 経路では使われない (delete state machine は別ファイル)。
    expect(asJson).not.toContain("startBuild.sync");
    expect(asJson).not.toContain('"StartDeployCodeBuild"');
  });

  it("should still write the same COMPLETE / FAILED DDB status transitions in the Lambda branch", () => {
    const asJson = definitionJson(buildTestStack({ deployViaLambda: true }).template);
    // status transitions (IN_PROGRESS→COMPLETE/FAILED) + stackId / stackOutputs 契約を維持。
    expect(asJson).toContain("IN_PROGRESS");
    expect(asJson).toContain("COMPLETE");
    expect(asJson).toContain("FAILED");
    expect(asJson).toContain("stackId");
    expect(asJson).toContain("stackOutputs");
    // Lambda 経路は buildId を書かない (= CodeBuild 固有)。
    expect(asJson).not.toContain("codebuild.Build.Id");
  });

  it("should require cfnDeployFunction when deployViaLambda is true", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "Bad", {
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
    expect(
      () =>
        new DeployCreateStateMachine(stack, "Sm", {
          codeBuildProject,
          describeStackFunction: describeStackFn,
          deploymentsTable: deployments,
          deployViaLambda: true,
        }),
    ).toThrow(/cfnDeployFunction is required/);
  });

  it("should require eventBus when deployViaLambda is true (fail loud, #2291)", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "NoBus", {
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
    const cfnDeployFn = new LambdaFunction(stack, "CfnDeployFn", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromInline("exports.handler = async () => ({});"),
    });
    // cfnDeployFunction は渡すが eventBus を渡さない → eventBus guard で throw。
    expect(
      () =>
        new DeployCreateStateMachine(stack, "Sm", {
          codeBuildProject,
          describeStackFunction: describeStackFn,
          deploymentsTable: deployments,
          deployViaLambda: true,
          cfnDeployFunction: cfnDeployFn,
        }),
    ).toThrow(/eventBus is required/);
  });

  it("should emit a Deploy Failed event on the Lambda failure path when deployViaLambda is true", () => {
    const { template } = buildTestStack({ deployViaLambda: true });
    const asJson = definitionJson(template);
    // MarkFailed の後段に EventBridge PutEvents task があり、custom event を出す。
    expect(asJson).toContain('"EmitDeployFailedEvent"');
    expect(asJson).toContain("events:putEvents"); // Step Functions の EventBridge 統合 ARN
    expect(asJson).toContain("TenkaCloud Deploy Failed"); // DetailType
    expect(asJson).toContain("tenkacloud.problem-deploy"); // Source
    // detail は failureReason を $.error.Cause から引く (= CodeBuild path MarkFailed と同 source)。
    expect(asJson).toContain('"failureReason.$":"$.error.Cause"');
    // MarkFailed → EmitDeployFailedEvent の順序 (= DDB を FAILED にしてから通知する)。
    expect(asJson).toContain('"Next":"EmitDeployFailedEvent"');
  });

  it("should NOT emit a Deploy Failed event when deployViaLambda is off (default-safe)", () => {
    const asJson = definitionJson(buildTestStack().template);
    expect(asJson).not.toContain("EmitDeployFailedEvent");
    expect(asJson).not.toContain("TenkaCloud Deploy Failed");
    expect(asJson).not.toContain("events:putEvents");
  });

  it("should grant the state machine role events:PutEvents (least-privilege) when the flag is ON", () => {
    const { template } = buildTestStack({ deployViaLambda: true });
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "events:PutEvents",
            }),
          ]),
        }),
      }),
    );
  });

  it("should require codeBuildProject on the default CodeBuild path", () => {
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "MissingCodeBuild", {
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
    expect(
      () =>
        new DeployCreateStateMachine(stack, "Sm", {
          describeStackFunction: describeStackFn,
          deploymentsTable: deployments,
        }),
    ).toThrow(/codeBuildProject is required/);
  });
});

describe("DeployCreateStateMachine SQL status-writer branch (#2441 Phase B PR-5)", () => {
  it("should replace the four DeployCreate status writes with LambdaInvoke tasks", () => {
    const asJson = definitionJson(buildTestStack({ statusWriter: true }).template);

    expect(asJson).toContain('"MarkInProgress"');
    expect(asJson).toContain('"MarkSucceeded"');
    expect(asJson).toContain('"MarkFailed"');
    expect(asJson).toContain('"MarkFailedWithoutBuildId"');
    expect(asJson).toContain('"transition":"markInProgress"');
    expect(asJson).toContain('"transition":"markSucceeded"');
    expect(asJson).toContain('"transition":"markFailed"');
    expect(asJson).not.toContain("dynamodb:updateItem");
  });

  it("should keep native DynamoUpdateItem tasks when statusWriterFunction is absent", () => {
    const asJson = definitionJson(buildTestStack().template);
    expect(asJson).toContain("dynamodb:updateItem");
    expect(asJson).not.toContain('"transition":"markSucceeded"');
  });

  it("should omit buildId from status-writer payloads on the Lambda deploy path", () => {
    const asJson = definitionJson(
      buildTestStack({ deployViaLambda: true, statusWriter: true }).template,
    );

    expect(asJson).toContain('"InvokeCfnDeploy"');
    expect(asJson).toContain('"transition":"markSucceeded"');
    expect(asJson).toContain('"transition":"markFailed"');
    expect(asJson).toContain('"EmitDeployFailedEvent"');
    expect(asJson).not.toContain("codebuild.Build.Id");
    expect(asJson).not.toContain("dynamodb:updateItem");
  });

  it("should retry every SQL status write before the recovery reconciler takes over (#2651)", () => {
    const definition = JSON.parse(
      definitionJson(buildTestStack({ statusWriter: true }).template),
    ) as {
      States: Record<
        string,
        {
          Retry?: Array<{
            ErrorEquals?: string[];
            IntervalSeconds?: number;
            MaxAttempts?: number;
            BackoffRate?: number;
          }>;
        }
      >;
    };
    for (const stateName of [
      "MarkInProgress",
      "MarkSucceeded",
      "MarkFailed",
      "MarkFailedWithoutBuildId",
    ]) {
      expect(definition.States[stateName]?.Retry).toEqual([
        {
          ErrorEquals: ["States.TaskFailed"],
          IntervalSeconds: 2,
          MaxAttempts: 4,
          BackoffRate: 2,
        },
      ]);
    }
  });
});
