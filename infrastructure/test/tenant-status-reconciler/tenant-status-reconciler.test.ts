import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, it } from "vitest";
import { TenantStatusReconciler } from "../../lib/tenant-status-reconciler/tenant-status-reconciler";

function synth() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const table = new Table(stack, "TenantMappingTable", {
    partitionKey: { name: "tenantId", type: AttributeType.STRING },
    billingMode: BillingMode.PROVISIONED,
    readCapacity: 1,
    writeCapacity: 1,
  });
  new TenantStatusReconciler(stack, "Reconciler", { tenantMappingTable: table });
  return { template: Template.fromStack(stack), stack };
}

describe("TenantStatusReconciler", () => {
  it("Lambda + EventBridge Rule を 1 セット作るべき", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.resourceCountIs("AWS::Events::Rule", 1);
  });

  it("Schedule は 2 分周期がデフォルトであるべき", () => {
    const { template } = synth();
    template.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        ScheduleExpression: "rate(2 minutes)",
      }),
    );
  });

  it("Lambda の environment に TENANT_MAPPING_TABLE_NAME を渡すべき", () => {
    const { template } = synth();
    template.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            TENANT_MAPPING_TABLE_NAME: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it("Lambda の IAM policy が TenantMappingTable への Scan + UpdateItem を grant すべき", () => {
    const { template } = synth();
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["dynamodb:Scan", "dynamodb:UpdateItem"]),
            }),
          ]),
        }),
      }),
    );
  });

  it("scheduleInterval を override できるべき", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "T", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    const table = new Table(stack, "TenantMappingTable", {
      partitionKey: { name: "tenantId", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
    });
    new TenantStatusReconciler(stack, "Reconciler", {
      tenantMappingTable: table,
      scheduleInterval: cdk.Duration.minutes(5),
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        ScheduleExpression: "rate(5 minutes)",
      }),
    );
  });
});
