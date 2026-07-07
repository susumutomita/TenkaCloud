import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_CAPACITY_CEILING,
  EventCapacityRunbook,
} from "../../lib/problem-deploy/event-capacity-runbook";

function stackWithTables(count: number): { stack: Stack; tables: Table[] } {
  const stack = new Stack(new App(), "TestStack");
  const tables = Array.from({ length: count }, (_, i) => {
    const table = new Table(stack, `T${i}`, {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    });
    return table;
  });
  return { stack, tables };
}

describe("EventCapacityRunbook (#2410)", () => {
  it("should create an SSM Automation document, not an auto-scaling target", () => {
    const { stack, tables } = stackWithTables(2);
    new EventCapacityRunbook(stack, "Runbook", { tables, documentName: "tc-dev-event-capacity" });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::SSM::Document", {
      DocumentType: "Automation",
      Name: "tc-dev-event-capacity",
    });
    // Explicitly NOT auto-scaling — that is the whole point (no silent ramp).
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
  });

  it("should bake the cost ceiling into the document (fat-finger guard)", () => {
    const { stack, tables } = stackWithTables(1);
    new EventCapacityRunbook(stack, "Runbook", {
      tables,
      documentName: "tc-dev-event-capacity",
      ceiling: 120,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::SSM::Document", {
      Content: Match.objectLike({
        schemaVersion: "0.3",
        mainSteps: [
          Match.objectLike({
            action: "aws:executeScript",
            inputs: Match.objectLike({ InputPayload: Match.objectLike({ Ceiling: 120 }) }),
          }),
        ],
      }),
    });
  });

  it("should default the ceiling to a bounded value", () => {
    const { stack, tables } = stackWithTables(1);
    new EventCapacityRunbook(stack, "Runbook", { tables, documentName: "tc-dev-event-capacity" });
    Template.fromStack(stack).hasResourceProperties("AWS::SSM::Document", {
      Content: Match.objectLike({
        mainSteps: [
          Match.objectLike({
            inputs: Match.objectLike({
              InputPayload: Match.objectLike({ Ceiling: DEFAULT_EVENT_CAPACITY_CEILING }),
            }),
          }),
        ],
      }),
    });
    expect(DEFAULT_EVENT_CAPACITY_CEILING).toBeLessThanOrEqual(500);
  });

  it("should give the automation role UpdateTable only on the named tables + indexes", () => {
    const { stack, tables } = stackWithTables(1);
    new EventCapacityRunbook(stack, "Runbook", { tables, documentName: "tc-dev-event-capacity" });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: "ssm.amazonaws.com" } })],
      }),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["dynamodb:DescribeTable", "dynamodb:UpdateTable"],
          }),
        ]),
      }),
    });
    // No table-destroying or account-wide grants.
    const policies = template.findResources("AWS::IAM::Policy");
    const actions = JSON.stringify(policies);
    expect(actions).not.toContain("dynamodb:DeleteTable");
    expect(actions).not.toContain('"Resource":"*"');
  });

  it("should reject an empty table list and a non-positive ceiling", () => {
    const { stack, tables } = stackWithTables(1);
    expect(() => new EventCapacityRunbook(stack, "R1", { tables: [], documentName: "x" })).toThrow(
      /at least one table/,
    );
    expect(
      () => new EventCapacityRunbook(stack, "R2", { tables, documentName: "x", ceiling: 0 }),
    ).toThrow(/positive integer/);
  });
});
