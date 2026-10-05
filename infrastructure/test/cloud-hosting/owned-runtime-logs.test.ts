import { App, Aspects, CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CfnProject } from "aws-cdk-lib/aws-codebuild";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import { LogGroupRetention } from "../../lib/cdk-aspect/log-group-retention.js";
import { OwnedRuntimeLogs } from "../../lib/cloud-hosting/owned-runtime-logs.js";

function stack() {
  const result = new Stack(new App(), "Logs");
  Aspects.of(result).add(new LogGroupRetention());
  Aspects.of(result).add(new OwnedRuntimeLogs());
  return result;
}
function lambda(scope: Stack, id: string, loggingConfig?: CfnFunction.LoggingConfigProperty) {
  return new CfnFunction(scope, id, {
    code: { zipFile: "exports.handler = async () => {};" },
    role: "arn:aws:iam::123456789012:role/synthetic",
    runtime: "nodejs24.x",
    handler: "index.handler",
    loggingConfig,
  });
}
describe("CFN owned runtime logs", () => {
  it("owns provider Lambda logs with short retention and Delete", () => {
    const scope = stack();
    lambda(scope, "Provider");
    const template = Template.fromStack(scope);
    const logs = template.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(logs)).toHaveLength(1);
    for (const resource of Object.values(logs)) {
      expect(resource).toMatchObject({
        Properties: { RetentionInDays: 1 },
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
      expect(resource.Properties.LogGroupName).toBeUndefined();
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: { Ref: Match.anyValue() } },
    });
  });
  it("bounds implicit logs when only log format is explicit", () => {
    const scope = stack();
    lambda(scope, "Json", { logFormat: "JSON", applicationLogLevel: "INFO" });
    const template = Template.fromStack(scope);
    expect(Object.keys(template.findResources("AWS::Logs::LogGroup"))).toHaveLength(1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: {
        LogFormat: "JSON",
        ApplicationLogLevel: "INFO",
        LogGroup: { Ref: Match.anyValue() },
      },
    });
  });
  it("preserves low-level explicit function destinations", () => {
    const scope = stack();
    lambda(scope, "ExplicitOverride").addPropertyOverride("LoggingConfig", {
      LogGroup: "/external/function",
      LogFormat: "JSON",
    });
    const template = Template.fromStack(scope);
    expect(Object.keys(template.findResources("AWS::Logs::LogGroup"))).toHaveLength(0);
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: "/external/function", LogFormat: "JSON" },
    });
  });
  it("preserves low-level explicit provider destinations", () => {
    const scope = stack();
    new Bucket(scope, "Bucket", {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });
    const provider = scope.node
      .findAll()
      .find(
        (node): node is CfnResource =>
          node instanceof CfnResource && node.cfnResourceType === "AWS::Lambda::Function",
      );
    if (!provider) throw new Error("S3 auto-delete provider was not constructed");
    provider.addPropertyOverride("LoggingConfig", {
      LogGroup: "/external/provider",
      LogFormat: "JSON",
    });
    const template = Template.fromStack(scope);
    expect(Object.keys(template.findResources("AWS::Logs::LogGroup"))).toHaveLength(0);
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: "/external/provider", LogFormat: "JSON" },
    });
  });
  it("preserves explicit destinations, disabled CodeBuild logging and explicit retention", () => {
    const scope = stack();
    lambda(scope, "Explicit", { logGroup: "/external/logs", logFormat: "JSON" });
    new CfnLogGroup(scope, "ExplicitLogs", { retentionInDays: 30 });
    new CfnLogGroup(scope, "DefaultLogs");
    const infinite = new LogGroup(scope, "InfiniteLogs", { retention: RetentionDays.INFINITE });
    new CfnProject(scope, "Build", {
      serviceRole: "synthetic",
      source: { type: "NO_SOURCE" },
      artifacts: { type: "NO_ARTIFACTS" },
      environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_SMALL",
        image: "synthetic",
      },
      logsConfig: { cloudWatchLogs: { status: "DISABLED" } },
    });
    const template = Template.fromStack(scope);
    expect(Object.keys(template.findResources("AWS::Logs::LogGroup"))).toHaveLength(3);
    const infiniteId = scope.getLogicalId(infinite.node.defaultChild as CfnLogGroup);
    const infiniteLogs = template.findResources("AWS::Logs::LogGroup")[infiniteId];
    expect(infiniteLogs).toBeDefined();
    expect(infiniteLogs?.Properties?.RetentionInDays).toBeUndefined();
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 1 });
    template.hasResourceProperties("AWS::Lambda::Function", {
      LoggingConfig: { LogGroup: "/external/logs", LogFormat: "JSON" },
    });
  });
});
