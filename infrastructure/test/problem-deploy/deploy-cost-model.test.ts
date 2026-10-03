import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_FIXED_TRANSITIONS,
  DEPLOY_POLL_CYCLE_TRANSITIONS,
  DEPLOY_STATUS_POLL_INTERVAL_SECONDS,
  deployTransitionCount,
  estimateDeployWaveCostUsd,
  SFN_STANDARD_USD_PER_1K_TRANSITIONS,
} from "../../lib/problem-deploy/deploy-cost-model";
import { DeployCreateStateMachine } from "../../lib/problem-deploy/deploy-create-state-machine";
import { DeployDeleteStateMachine } from "../../lib/problem-deploy/deploy-delete-state-machine";

/**
 * Issue #2291: machine-check the Step Functions cost model for the Lambda deploy path,
 * so the ≈$0.7/wave estimate is anchored and a future change to the poll interval / state count that
 * would blow the budget fails a test instead of a live bill.
 */

const DESIGN_WAVE_DEPLOYS = 750;
const TYPICAL_DEPLOY_SECONDS = 300; // a 5-min hello-world-style deploy

function lambdaFn(stack: cdk.Stack, id: string): LambdaFunction {
  return new LambdaFunction(stack, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({});"),
  });
}

function deployStateMachineAsl(kind: "create" | "delete"): string {
  const app = new cdk.App({ autoSynth: false });
  const stack = new cdk.Stack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const deployments = new Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
  });
  const cfnDeployFn = lambdaFn(stack, "CfnDeployFn");
  if (kind === "create") {
    new DeployCreateStateMachine(stack, "Sm", {
      describeStackFunction: lambdaFn(stack, "DescribeStackFn"),
      deploymentsTable: deployments,
      deployViaLambda: true,
      cfnDeployFunction: cfnDeployFn,
      eventBus: new EventBus(stack, "Bus"),
    });
  } else {
    new DeployDeleteStateMachine(stack, "Sm", {
      deploymentsTable: deployments,
      deployViaLambda: true,
      cfnDeployFunction: cfnDeployFn,
    });
  }
  const template = Template.fromStack(stack);
  const sm = Object.values(template.findResources("AWS::StepFunctions::StateMachine"))[0];
  const definitionString = sm?.Properties?.DefinitionString;
  if (typeof definitionString === "string") return definitionString;
  const parts = definitionString["Fn::Join"][1] as Array<string | Record<string, unknown>>;
  return parts.map((p) => (typeof p === "string" ? p : "ARN")).join("");
}

describe("deploy cost model (#2291)", () => {
  it("should count fixed + per-cycle transitions for one deploy", () => {
    // 300s deploy / 30s poll = 10 cycles → 3 fixed + 3*10 = 33 transitions.
    expect(deployTransitionCount(TYPICAL_DEPLOY_SECONDS, 30)).toBe(
      DEPLOY_FIXED_TRANSITIONS + DEPLOY_POLL_CYCLE_TRANSITIONS * 10,
    );
  });

  it("should count at least one poll cycle even when the stack is already terminal", () => {
    // deploySeconds <= 0 (terminal on the first poll) still runs one Wait+Describe+Choice cycle.
    expect(deployTransitionCount(0, 30)).toBe(
      DEPLOY_FIXED_TRANSITIONS + DEPLOY_POLL_CYCLE_TRANSITIONS,
    );
    expect(deployTransitionCount(-5, 30)).toBe(
      DEPLOY_FIXED_TRANSITIONS + DEPLOY_POLL_CYCLE_TRANSITIONS,
    );
  });

  it("should reject a non-positive or non-finite poll interval", () => {
    expect(() => deployTransitionCount(300, 0)).toThrow(/greater than zero/);
    expect(() => deployTransitionCount(300, -1)).toThrow(/greater than zero/);
    expect(() => deployTransitionCount(Number.NaN, 30)).toThrow(/finite/);
    expect(() => deployTransitionCount(300, Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("should keep a 750-deploy wave below the ~$0.7 design budget", () => {
    const cost = estimateDeployWaveCostUsd({
      deploys: DESIGN_WAVE_DEPLOYS,
      deploySeconds: TYPICAL_DEPLOY_SECONDS,
    });
    // 750 * 33 * 0.025/1000 = $0.61875 — within the ~$0.7/wave estimate.
    expect(cost).toBeCloseTo(0.619, 2);
    expect(cost).toBeLessThanOrEqual(0.7);
    // ...and a full order of magnitude under the ≈$37.50 CodeBuild baseline the migration replaces.
    expect(cost).toBeLessThan(37.5 / 10);
  });

  it("should show the old 15s interval overshot the ~$0.7 target (why it was tuned)", () => {
    const cost15 = estimateDeployWaveCostUsd({
      deploys: DESIGN_WAVE_DEPLOYS,
      deploySeconds: TYPICAL_DEPLOY_SECONDS,
      pollIntervalSeconds: 15,
    });
    // 300/15 = 20 cycles → 63 transitions → 750 * 63 * 0.025/1000 = $1.18125 > $0.7.
    expect(cost15).toBeCloseTo(1.181, 2);
    expect(cost15).toBeGreaterThan(0.7);
    expect(cost15).toBeGreaterThan(
      estimateDeployWaveCostUsd({
        deploys: DESIGN_WAVE_DEPLOYS,
        deploySeconds: TYPICAL_DEPLOY_SECONDS,
      }),
    );
  });

  it("should reject a negative or non-finite deploy count", () => {
    expect(() => estimateDeployWaveCostUsd({ deploys: -1, deploySeconds: 300 })).toThrow(
      /non-negative/,
    );
    expect(() => estimateDeployWaveCostUsd({ deploys: Number.NaN, deploySeconds: 300 })).toThrow(
      /non-negative/,
    );
  });

  it("should expose the SFN Standard price and a 30s default poll interval", () => {
    expect(SFN_STANDARD_USD_PER_1K_TRANSITIONS).toBe(0.025);
    expect(DEPLOY_STATUS_POLL_INTERVAL_SECONDS).toBe(30);
  });

  it("should wire the 30s poll interval into the create + delete Lambda state machines", () => {
    for (const kind of ["create", "delete"] as const) {
      const asl = deployStateMachineAsl(kind);
      expect(asl).toContain('"WaitBeforePoll"');
      expect(asl).toContain('"Seconds":30');
      expect(asl).not.toContain('"Seconds":15');
    }
  });
});
