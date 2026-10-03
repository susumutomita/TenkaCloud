import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Pass, StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { describe, expect, it } from "vitest";
import { BulkDeployCreateStateMachine } from "../../lib/problem-deploy/bulk-deploy-create-state-machine";

/**
 * Issue #910 (#895 Phase 2.C.1): BulkDeployCreateStateMachine の CFn shape を pin する
 * regression test。 Distributed Map / S3JsonItemReader / MaxConcurrency=50 / Standard
 * child execution の 4 つの設計判断が ASL に反映されているかを assertion する。
 */

function buildStack(): { stack: cdk.Stack; template: Template } {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const payloadBucket = new Bucket(stack, "PayloadBucket");
  // child の具体動作は別 suite が検証するため、ここでは minimal Pass の Standard SM を使う。
  const childSm = new StateMachine(stack, "ChildSm", {
    definition: new Pass(stack, "ChildPass"),
  });
  new BulkDeployCreateStateMachine(stack, "Bulk", {
    childStateMachine: childSm,
    payloadBucket,
  });
  return { stack, template: Template.fromStack(stack) };
}

function asJsonString(definitionString: unknown): string {
  if (typeof definitionString === "string") return definitionString;
  const join = (definitionString as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
  const parts = join[1] as Array<string | Record<string, unknown>>;
  return parts.map((p) => (typeof p === "string" ? p : "ARN_PLACEHOLDER")).join("");
}

describe("BulkDeployCreateStateMachine", () => {
  it("should include a Distributed Map state (not Standard Map; for 750 batch)", () => {
    const { template } = buildStack();
    const sm = Object.values(template.findResources("AWS::StepFunctions::StateMachine")).find(
      (r) => {
        const def = asJsonString(r.Properties?.DefinitionString);
        return def.includes("DeployItemsMap");
      },
    );
    expect(sm).toBeDefined();
    const def = asJsonString(sm?.Properties?.DefinitionString);
    expect(def).toContain('"Type":"Map"');
    expect(def).toContain('"ProcessorConfig"');
    expect(def).toContain('"Mode":"DISTRIBUTED"');
    expect(def).toContain('"ExecutionType":"STANDARD"');
  });

  it("should fix MaxConcurrency at 50", () => {
    const { template } = buildStack();
    const sm = Object.values(template.findResources("AWS::StepFunctions::StateMachine")).find(
      (r) => {
        const def = asJsonString(r.Properties?.DefinitionString);
        return def.includes("DeployItemsMap");
      },
    );
    const def = asJsonString(sm?.Properties?.DefinitionString);
    expect(def).toContain('"MaxConcurrency":50');
  });

  it("S3 ItemReader を含む (= JSON array of deployments を読む)", () => {
    const { template } = buildStack();
    const sm = Object.values(template.findResources("AWS::StepFunctions::StateMachine")).find(
      (r) => {
        const def = asJsonString(r.Properties?.DefinitionString);
        return def.includes("DeployItemsMap");
      },
    );
    const def = asJsonString(sm?.Properties?.DefinitionString);
    expect(def).toContain('"ItemReader"');
    expect(def).toContain('"Resource":"arn:');
    expect(def).toContain("s3:getObject");
    expect(def).toContain('"ReaderConfig"');
    expect(def).toContain('"InputType":"JSON"');
  });

  it("should attach S3 Bucket Read permissions to the State Machine Role", () => {
    const { template } = buildStack();
    // IAM policy で s3:GetObject + s3:ListBucket が付く
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["s3:GetObject*"]),
            }),
          ]),
        }),
      }),
    );
  });

  it("should attach StartExecution permission to the Child State Machine", () => {
    const { template } = buildStack();
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "states:StartExecution",
            }),
          ]),
        }),
      }),
    );
  });
});
