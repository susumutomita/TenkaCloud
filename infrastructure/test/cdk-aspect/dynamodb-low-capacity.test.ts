import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, CfnTable, Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoDbLowCapacity } from "../../lib/cdk-aspect/dynamodb-low-capacity";

/**
 * DynamoDbLowCapacity Aspect は cost-zero invariant の中心。
 * CLAUDE.md "No on-demand DynamoDB" / Free Tier 25 RCU/WCU の根拠なので
 * stack-level の結合テストでは見えにくい 3 つの単位挙動を直接 assert する。
 */
describe("DynamoDbLowCapacity aspect", () => {
  it("should force PROVISIONED tables to the (read, write) capacity supplied by the caller", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "ProvisionedStack");
    new Table(stack, "Provisioned", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
    });
    Aspects.of(app).add(new DynamoDbLowCapacity(1, 1));
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    });
  });

  it("should leave PAY_PER_REQUEST tables untouched (no ProvisionedThroughput injected)", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "OnDemandStack");
    new Table(stack, "OnDemand", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });
    Aspects.of(app).add(new DynamoDbLowCapacity(1, 1));
    const template = Template.fromStack(stack);
    const tables = template.findResources("AWS::DynamoDB::Table");
    for (const table of Object.values(tables)) {
      const props = (table as { Properties: Record<string, unknown> }).Properties;
      expect(props.BillingMode).toBe("PAY_PER_REQUEST");
      expect(props.ProvisionedThroughput).toBeUndefined();
    }
  });

  it("should convert selected third-party PAY_PER_REQUEST tables to PROVISIONED capacity", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "ThirdPartyOnDemandStack");
    new Table(stack, "ThirdPartyOnDemand", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });
    Aspects.of(app).add(
      new DynamoDbLowCapacity(1, 1, {
        convertOnDemand: (table) => table.node.path.includes("ThirdPartyOnDemand"),
      }),
    );
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    });
  });

  it("should overwrite each GlobalSecondaryIndex throughput when CfnTable exposes a concrete array", () => {
    // L1 CfnTable で GSI を直接 array として渡すと aspect の Array.isArray 分岐に入る。
    // L2 Table.addGlobalSecondaryIndex は IResolvable を返すため aspect が触らない (設計どおり)。
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "GsiStack");
    new CfnTable(stack, "WithGsi", {
      keySchema: [{ attributeName: "pk", keyType: "HASH" }],
      attributeDefinitions: [
        { attributeName: "pk", attributeType: "S" },
        { attributeName: "email", attributeType: "S" },
      ],
      billingMode: "PROVISIONED",
      provisionedThroughput: { readCapacityUnits: 10, writeCapacityUnits: 10 },
      globalSecondaryIndexes: [
        {
          indexName: "byEmail",
          keySchema: [{ attributeName: "email", keyType: "HASH" }],
          projection: { projectionType: "ALL" },
          provisionedThroughput: { readCapacityUnits: 8, writeCapacityUnits: 8 },
        },
      ],
    });
    Aspects.of(app).add(new DynamoDbLowCapacity(1, 1));
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      GlobalSecondaryIndexes: [
        {
          IndexName: "byEmail",
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
        },
      ],
    });
  });

  it("should apply a raised capacity to both the table and its GSIs (Issue #2679 deploy knob)", () => {
    // #2679 exposes CDK_PARAM_DYNAMODB_READ/WRITE_CAPACITY through the lite pipeline.
    // The aspect is the single place that fans the value out, so pin the raised-value
    // direction too — not just the 1/1 floor — including the GSI overwrite.
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "RaisedStack");
    new CfnTable(stack, "WithGsi", {
      keySchema: [{ attributeName: "pk", keyType: "HASH" }],
      attributeDefinitions: [
        { attributeName: "pk", attributeType: "S" },
        { attributeName: "email", attributeType: "S" },
      ],
      billingMode: "PROVISIONED",
      provisionedThroughput: { readCapacityUnits: 1, writeCapacityUnits: 1 },
      globalSecondaryIndexes: [
        {
          indexName: "byEmail",
          keySchema: [{ attributeName: "email", keyType: "HASH" }],
          projection: { projectionType: "ALL" },
          provisionedThroughput: { readCapacityUnits: 1, writeCapacityUnits: 1 },
        },
      ],
    });
    Aspects.of(app).add(new DynamoDbLowCapacity(25, 10));
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 10 },
      GlobalSecondaryIndexes: [
        {
          IndexName: "byEmail",
          ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 10 },
        },
      ],
    });
  });
});
