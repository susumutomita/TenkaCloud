import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../lib/app-config/types";
import { applyDynamoLowCapacity } from "../../lib/app-wiring/wire/aspects";
import { ControlPlaneStack } from "../../lib/control-plane-stack";

describe("SBT tenant-registration table capacity", () => {
  it("should preserve the SBT 0.3.9 tenant table logical id during the 0.9.5 upgrade", () => {
    const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new ControlPlaneStack(app, "ControlPlane", {
      env: { account: "123456789012", region: "ap-northeast-1" },
      systemAdminEmail: "admin@example.com",
    });

    const resources = Template.fromStack(stack).toJSON().Resources;

    expect(resources).toHaveProperty(
      "ControlPlanetenantManagementServicvestenantManagementTableTenantDetails974E95B8",
    );
    expect(resources).not.toHaveProperty(
      "ControlPlanetenantManagementServicetenantManagementTableTenantDetails7131CA8F",
    );
  });

  it("should synthesize the SBT 0.9.5 registration table as PROVISIONED 1/1", () => {
    const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new ControlPlaneStack(app, "ControlPlane", {
      env: { account: "123456789012", region: "ap-northeast-1" },
      systemAdminEmail: "admin@example.com",
    });
    applyDynamoLowCapacity(
      stack,
      {
        dynamoReadCapacity: 1,
        dynamoWriteCapacity: 1,
        isDynamoProvisioned: true,
      } as AppConfig,
      { convertSbtTenantRegistrationTable: true },
    );

    Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PROVISIONED",
      KeySchema: [{ AttributeName: "tenantRegistrationId", KeyType: "HASH" }],
      ProvisionedThroughput: {
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1,
      },
    });
  });

  it("should PATCH lifecycle failure jobOutput to the registration identified by the event", () => {
    const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new ControlPlaneStack(app, "ControlPlane", {
      env: { account: "123456789012", region: "ap-northeast-1" },
      systemAdminEmail: "admin@example.com",
    });
    const rules = Template.fromStack(stack).findResources("AWS::Events::Rule");
    const failureRules = Object.values(rules).filter((resource) =>
      (JSON.stringify(resource.Properties?.EventPattern?.["detail-type"]) ?? "").includes(
        "Failure",
      ),
    );

    expect(failureRules).toHaveLength(2);
    for (const rule of failureRules) {
      expect(rule.Properties.Targets[0]).toMatchObject({
        HttpParameters: {
          PathParameterValues: ["$.detail.tenantRegistrationId"],
        },
        InputPath: "$.detail.jobOutput",
      });
    }
  });
});
