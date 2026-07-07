import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  EVENT_CAPACITY_CEILING,
  EVENT_CAPACITY_PARAM_PATTERN,
} from "../lib/problem-deploy/event-capacity-constants";
import { SYNTH_TIMEOUT_MS, synthDefault } from "./problem-deploy-backend-stack.test-helpers";

/**
 * Issue #2410: event capacity ops wiring.
 *
 *  - Slice 1: SSM Automation runbook (bounded ceiling) + least-privilege automation role
 *  - Slice 2: EventApi Lambda monitoring wiring (env + DescribeTable / GetMetricData IAM)
 */
describe("ProblemDeployBackendStack — event capacity runbook (#2410)", {
  timeout: SYNTH_TIMEOUT_MS,
}, () => {
  const tpl = synthDefault();

  interface SsmDocumentProps {
    Properties?: {
      DocumentType?: string;
      UpdateMethod?: string;
      Name?: string;
      Content?: {
        schemaVersion?: string;
        parameters?: Record<
          string,
          { allowedValues?: unknown[]; allowedPattern?: string; type?: string }
        >;
        mainSteps?: { action?: string; inputs?: { Script?: string; Runtime?: string } }[];
      };
    };
  }

  function findRunbook(): SsmDocumentProps {
    const docs = tpl.findResources("AWS::SSM::Document");
    const entry = Object.entries(docs).find(([name]) => name.includes("EventCapacityRunbook"));
    expect(entry).toBeDefined();
    return entry?.[1] as SsmDocumentProps;
  }

  it("should create an SSM Automation document named <stack>-event-capacity with NewVersion updates", () => {
    const doc = findRunbook();
    expect(doc.Properties?.DocumentType).toBe("Automation");
    expect(doc.Properties?.UpdateMethod).toBe("NewVersion");
    expect(doc.Properties?.Name).toBe("TestStack-event-capacity");
  });

  it("should pin TableName to exactly the 5 event-hot tables via allowedValues", () => {
    const params = findRunbook().Properties?.Content?.parameters;
    // allowedValues は synth 時に 5 テーブルの Ref token になる (= 他テーブル名は構造的に不可)。
    expect(params?.TableName?.allowedValues).toHaveLength(5);
  });

  it(`should reject capacity outside 1..${EVENT_CAPACITY_CEILING} via allowedPattern on both RCU and WCU`, () => {
    const params = findRunbook().Properties?.Content?.parameters;
    expect(params?.ReadCapacityUnits?.allowedPattern).toBe(EVENT_CAPACITY_PARAM_PATTERN);
    expect(params?.WriteCapacityUnits?.allowedPattern).toBe(EVENT_CAPACITY_PARAM_PATTERN);
    // 桁打ち間違い (2000) と 0 は pattern が弾き、200 と 1 は通る。
    const re = new RegExp(EVENT_CAPACITY_PARAM_PATTERN);
    expect(re.test("2000")).toBe(false);
    expect(re.test("0")).toBe(false);
    expect(re.test("1")).toBe(true);
    expect(re.test("200")).toBe(true);
  });

  it("should keep the ceiling assert inside the executeScript step as defense in depth", () => {
    const steps = findRunbook().Properties?.Content?.mainSteps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe("aws:executeScript");
    expect(steps[0]?.inputs?.Runtime).toBe("python3.11");
    expect(steps[0]?.inputs?.Script).toContain(`CEILING = ${EVENT_CAPACITY_CEILING}`);
    // GSI もまとめて同値に揃える (= base だけ上げて GSI throttle で詰まる事故を防ぐ)。
    expect(steps[0]?.inputs?.Script).toContain("GlobalSecondaryIndexUpdates");
    // 課金合計 (指定値 x (1 + GSI 数)) を実行結果に出す (= ceiling は parameter 単位である
    // ことの透明化。#2410 課金爆死ガードの補助線)。
    expect(steps[0]?.inputs?.Script).toContain("billedReadCapacityUnits");
    expect(steps[0]?.inputs?.Script).toContain("billedWriteCapacityUnits");
  });

  it("should grant the automation role only DescribeTable/UpdateTable on the event-hot tables", () => {
    tpl.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "ssm.amazonaws.com" } }),
        ]),
      }),
      Policies: [
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: [
              Match.objectLike({
                Action: ["dynamodb:DescribeTable", "dynamodb:UpdateTable"],
                Resource: Match.arrayWith([
                  Match.objectLike({
                    "Fn::GetAtt": [Match.stringLikeRegexp("Deployments"), "Arn"],
                  }),
                ]),
              }),
            ],
          }),
        }),
      ],
    });
  });

  it("should output the runbook document name for the operator CLI", () => {
    tpl.hasOutput("EventCapacityRunbookName", {});
  });

  it("should wire the EventApi Lambda with the 5th table env and the runbook name (#2410 Slice 2)", () => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const eventApi = Object.entries(functions).find(
      ([name]) => name.includes("EventApi") && name.includes("Function"),
    );
    const vars =
      (
        eventApi?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.PROBLEM_ENDPOINTS_TABLE_NAME).toBeDefined();
    expect(vars.CAPACITY_RUNBOOK_DOCUMENT_NAME).toBeDefined();
  });

  it("should grant the EventApi Lambda DescribeTable + GetMetricData for the monitoring read", () => {
    const policies = tpl.findResources("AWS::IAM::Policy");
    const eventApiPolicy = Object.entries(policies).find(([name]) =>
      name.includes("EventApiFunctionServiceRoleDefaultPolicy"),
    );
    expect(eventApiPolicy).toBeDefined();
    const statements =
      (
        eventApiPolicy?.[1] as {
          Properties?: { PolicyDocument?: { Statement?: { Action?: unknown }[] } };
        }
      )?.Properties?.PolicyDocument?.Statement ?? [];
    const actions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string],
    );
    expect(actions).toContain("dynamodb:DescribeTable");
    expect(actions).toContain("cloudwatch:GetMetricData");
  });
});
