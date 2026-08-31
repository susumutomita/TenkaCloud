import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, it } from "vitest";
import { TenantStatusReconciler } from "../../lib/tenant-status-reconciler/tenant-status-reconciler";

function synth() {
  const app = new cdk.App({ autoSynth: false });
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
  it("should create 1 set of Lambda + EventBridge Rule", () => {
    const { template } = synth();
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.resourceCountIs("AWS::Events::Rule", 1);
  });

  it("Schedule should default to a 2-minute interval", () => {
    const { template } = synth();
    template.hasResourceProperties(
      "AWS::Events::Rule",
      Match.objectLike({
        ScheduleExpression: "rate(2 minutes)",
      }),
    );
  });

  it("should pass TENANT_MAPPING_TABLE_NAME to the Lambda environment", () => {
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

  it("Lambda IAM policy should grant Scan + UpdateItem on TenantMappingTable", () => {
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

  it("should allow overriding scheduleInterval", () => {
    const app = new cdk.App({ autoSynth: false });
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
