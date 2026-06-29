/**
 * [Composite Runtime / Issue #2061] CDK synth test for the Deployments table
 * GSI3 (parent → target lookup). Asserts the exact GSI3 key schema and that
 * adding it does not loosen the table settings or disturb GSI1 / GSI2.
 */

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DeploymentsTable } from "../../lib/problem-deploy/deployments-table";

function synthTable(): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  new DeploymentsTable(stack, "Deployments");
  return Template.fromStack(stack);
}

describe("DeploymentsTable GSI3 (#2061)", () => {
  const tpl = synthTable();

  it("synthesizes GSI3 without changing existing GSI definitions", () => {
    tpl.hasResourceProperties("AWS::DynamoDB::Table", {
      // Base table key + provisioning unchanged.
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        }),
        Match.objectLike({
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "GSI2PK", KeyType: "HASH" },
            { AttributeName: "GSI2SK", KeyType: "RANGE" },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        }),
        Match.objectLike({
          IndexName: "GSI3",
          KeySchema: [
            { AttributeName: "GSI3PK", KeyType: "HASH" },
            { AttributeName: "GSI3SK", KeyType: "RANGE" },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        }),
      ]),
    });
  });

  it("declares GSI3PK and GSI3SK as string attributes", () => {
    tpl.hasResourceProperties("AWS::DynamoDB::Table", {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "GSI3PK", AttributeType: "S" },
        { AttributeName: "GSI3SK", AttributeType: "S" },
      ]),
    });
  });

  it("keeps exactly three global secondary indexes", () => {
    const tables = tpl.findResources("AWS::DynamoDB::Table");
    const table = Object.values(tables)[0];
    const gsis = table.Properties.GlobalSecondaryIndexes as Array<{ IndexName: string }>;
    expect(gsis.map((g) => g.IndexName).sort()).toEqual(["GSI1", "GSI2", "GSI3"]);
  });

  it("keeps TTL on expiresAt and RETAIN removal policy", () => {
    tpl.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    tpl.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
  });
});
