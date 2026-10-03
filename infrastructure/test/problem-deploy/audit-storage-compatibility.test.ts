import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { EventBus } from "aws-cdk-lib/aws-events";
import { describe, expect, it } from "vitest";
import { AdminAuditLogTable } from "../../lib/problem-deploy/admin-audit-log-table";
import { SystemAuditWriterLambda } from "../../lib/problem-deploy/system-audit-writer-lambda";

describe("retired audit storage/resource compatibility", () => {
  it("preserves the saved-history table identity, keys, GSI, TTL and existing removal policy", () => {
    const stack = new Stack(new App(), "StorageCompatibility");
    const history = new AdminAuditLogTable(stack, "AdminAuditLog");
    expect(history.table.node.path).toBe("StorageCompatibility/AdminAuditLog/Table");
    const template = Template.fromStack(stack);
    expect(Object.keys(template.findResources("AWS::DynamoDB::Table"))).toEqual([
      "AdminAuditLogTable670D7986",
    ]);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: {
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          },
        ],
      },
    });
  });
  it("keeps the compatibility writer and operational log group but disables every dedicated subscription", () => {
    const stack = new Stack(new App(), "WriterCompatibility");
    const history = new AdminAuditLogTable(stack, "AdminAuditLog");
    const writer = new SystemAuditWriterLambda(stack, "SystemAuditWriter", {
      eventBus: new EventBus(stack, "Events"),
      adminAuditLogTable: history.table,
      environmentName: "test",
      auditLogEnabled: true,
      deployViaLambda: true,
    });
    expect(writer.fn.node.path).toBe("WriterCompatibility/SystemAuditWriter/Function");
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.resourceCountIs("AWS::Logs::LogGroup", 1);
    const rules = Object.values(template.findResources("AWS::Events::Rule"));
    expect(rules).toHaveLength(3);
    for (const rule of rules) expect(rule.Properties.State).toBe("DISABLED");
  });
});
