import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, it } from "vitest";
import { ServerlessSaaSPipeline } from "../../lib/tenant-pipeline/serverless-saas-pipeline";

function synth(): Template {
  const app = new App({ autoSynth: false });
  const sharedStack = new Stack(app, "TestSharedResources", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const stack = new ServerlessSaaSPipeline(app, "TestServerlessSaaSPipeline", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    appName: "TenkaCloud",
    environmentName: "development",
    tenantMappingTable: new Table(sharedStack, "TestTenantMappingTable", {
      partitionKey: { name: "tenantId", type: AttributeType.STRING },
      readCapacity: 1,
      writeCapacity: 1,
    }),
    s3SourceBucket: "tenkacloud-source-123456789012-ap-northeast-1",
    sourceZip: "source.zip",
  });
  return Template.fromStack(stack);
}

describe("ServerlessSaaSPipeline runtimes", () => {
  it("tenant pipeline Python Lambda should use the latest runtime", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Handler: "lambda-prepare-deploy.lambda_handler",
        Runtime: "python3.14",
      }),
    );
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Handler: "iterator.lambda_handler",
        Runtime: "python3.14",
      }),
    );
  });

  it("tenant provisioning CodeBuild should use the latest standard image", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::CodeBuild::Project",
      Match.objectLike({
        Environment: Match.objectLike({
          Image: "aws/codebuild/standard:8.0",
          Type: "LINUX_CONTAINER",
        }),
      }),
    );
  });
});

describe("ServerlessSaaSPipeline state machine name", () => {
  it("should include app and environment to avoid collisions on multiple deploys in the same account/region", () => {
    const tpl = synth();
    tpl.hasResourceProperties(
      "AWS::StepFunctions::StateMachine",
      Match.objectLike({
        StateMachineName: "tenkacloud-development-saas-deployment-machine",
      }),
    );
  });
});
