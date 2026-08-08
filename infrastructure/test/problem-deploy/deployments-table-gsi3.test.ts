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

  // [Issue #2959] 既定は RETAIN から DESTROY へ反転した。 残った table が PROVISIONED 容量で
  // 課金され続けるほうが実害が大きい、という運用判断による。 RETAIN は
  // `CDK_PARAM_RETAIN_DATA_TABLES=true` の opt-in になり、両方向の assertion は
  // `test/problem-deploy/data-table-removal-policy.test.ts` が 8 table 分まとめて持つ。
  it("keeps TTL on expiresAt and defaults to a destroyable removal policy", () => {
    tpl.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    tpl.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete" });
  });
});
