import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BootstrapTemplateStack } from "../../lib/bootstrap-template/bootstrap-template-stack";

function synthesizeBootstrap(): Record<string, unknown> {
  const app = new cdk.App({ autoSynth: false });
  const stack = new BootstrapTemplateStack(app, "Bootstrap", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    apiKeySSMParameterNames: {
      basic: { keyId: "/basic/id", value: "/basic/value" },
      standard: { keyId: "/standard/id", value: "/standard/value" },
      premium: { keyId: "/premium/id", value: "/premium/value" },
      platinum: { keyId: "/platinum/id", value: "/platinum/value" },
    },
    apiKeyPlatinumTierParameter: "platinum",
    apiKeyPremiumTierParameter: "premium",
    apiKeyStandardTierParameter: "standard",
    apiKeyBasicTierParameter: "basic",
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/tenkacloud-control-plane",
    systemAdminEmail: "admin@example.com",
    sourceBucketName: "source-bucket",
  });
  return Template.fromStack(stack).toJSON();
}

function parseDefinitionString(definitionString: unknown): {
  readonly States: Record<string, Record<string, unknown>>;
} {
  if (typeof definitionString === "string") return JSON.parse(definitionString);
  const join = (definitionString as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
  const serialized = join[1]
    .map((part) => (typeof part === "string" ? part : "CFN_TOKEN"))
    .join("");
  return JSON.parse(serialized);
}

function lifecycleDefinitions(template: Record<string, unknown>): Array<{
  readonly States: Record<string, Record<string, unknown>>;
}> {
  const resources = template.Resources as Record<
    string,
    { Type: string; Properties: { Definition?: unknown; DefinitionString?: unknown } }
  >;
  return Object.values(resources)
    .filter((resource) => resource.Type === "AWS::StepFunctions::StateMachine")
    .map((resource) => {
      if (resource.Properties.Definition) {
        return resource.Properties.Definition as {
          readonly States: Record<string, Record<string, unknown>>;
        };
      }
      return parseDefinitionString(resource.Properties.DefinitionString);
    });
}

function failureEventEntry(definition: {
  readonly States: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const failureState = definition.States.notifyFailureEventBridgeTask as {
    Parameters: { Entries: Record<string, unknown>[] };
  };
  return failureState.Parameters.Entries[0];
}

describe("bootstrap SBT 0.9.5 lifecycle contract", () => {
  it("should route prefixed onboarding and offboarding requests from the control plane", () => {
    const template = synthesizeBootstrap();
    const serialized = JSON.stringify(template);

    expect(serialized).toContain("sbt.control.plane");
    expect(serialized).toContain("sbt_aws_onboardingRequest");
    expect(serialized).toContain("sbt_aws_offboardingRequest");
  });

  it("should emit structurally valid success and terminal failure registration patches", () => {
    const template = synthesizeBootstrap();
    const definitions = lifecycleDefinitions(template);
    const entries = definitions.map(failureEventEntry);
    const byDetailType = new Map(entries.map((entry) => [entry.DetailType, entry]));

    expect(byDetailType.get("sbt_aws_provisionFailure")).toMatchObject({
      Detail: {
        "tenantRegistrationId.$": "$.detail.tenantRegistrationId",
        jobOutput: {
          tenantData: { tenantStatus: "Failed" },
          tenantRegistrationData: { registrationStatus: "Failed" },
        },
      },
      Source: "sbt.application.plane",
    });
    expect(byDetailType.get("sbt_aws_deprovisionFailure")).toMatchObject({
      Detail: {
        "tenantRegistrationId.$": "$.detail.tenantRegistrationId",
        jobOutput: {
          tenantData: { tenantStatus: "Failed" },
          tenantRegistrationData: { registrationStatus: "Failed" },
        },
      },
      Source: "sbt.application.plane",
    });
  });
});
