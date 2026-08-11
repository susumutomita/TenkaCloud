import * as cdk from "aws-cdk-lib";
import { Match, type Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CoordinationDispatcherLambda } from "../../lib/problem-deploy/coordination-dispatcher-lambda";
import { CoordinationPluginBundle } from "../../lib/problem-deploy/coordination-plugin-bundle";
import { SYNTH_TIMEOUT_MS } from "../problem-deploy-backend-stack.test-helpers";

const SAMPLE_PLUGIN =
  "export default { initialState: () => ({}), validateOp: () => ({ ok: true }), " +
  "applyOp: (s) => s, projectForTeam: (s) => s };\n";

function synthBundle(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new CoordinationPluginBundle(stack, "Bundle", { bundles: { p1: SAMPLE_PLUGIN } });
  return cdk.assertions.Template.fromStack(stack);
}

function synthDispatcherWithBucket(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const tableProps = {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  };
  const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", tableProps);
  const events = new cdk.aws_dynamodb.Table(stack, "Events", tableProps);
  const bucket = new cdk.aws_s3.Bucket(stack, "PluginBucket");
  new CoordinationDispatcherLambda(stack, "Dispatcher", {
    deploymentsTable: deployments,
    eventsTable: events,
    environmentName: "development",
    pluginBucket: bucket,
  });
  return cdk.assertions.Template.fromStack(stack);
}

// Role の inline Policies (= Properties.Policies) と grantRead が足す AWS::IAM::Policy の双方から
// action を集める (trust policy は除外)。
function allActions(tpl: Template): string[] {
  const fromRoles = Object.values(tpl.findResources("AWS::IAM::Role")).flatMap((r) =>
    (
      (r as { Properties?: { Policies?: Array<{ PolicyDocument?: { Statement?: unknown[] } }> } })
        .Properties?.Policies ?? []
    ).flatMap((p) => p.PolicyDocument?.Statement ?? []),
  );
  const fromPolicies = Object.values(tpl.findResources("AWS::IAM::Policy")).flatMap(
    (p) =>
      (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
        ?.PolicyDocument?.Statement ?? [],
  );
  return [...fromRoles, ...fromPolicies].flatMap((s) => {
    const a = (s as { Action?: string | string[] }).Action;
    return Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
  });
}

describe("CoordinationPluginBundle", () => {
  it(
    "should provision a private S3 bucket and a BucketDeployment",
    () => {
      const tpl = synthBundle();
      tpl.hasResourceProperties(
        "AWS::S3::Bucket",
        Match.objectLike({
          PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
        }),
      );
      // BucketDeployment は Custom::CDKBucketDeployment custom resource を出す。
      expect(Object.keys(tpl.findResources("Custom::CDKBucketDeployment")).length).toBeGreaterThan(
        0,
      );
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe("CoordinationDispatcherLambda with pluginBucket", () => {
  it(
    "should set COORDINATION_PLUGIN_BUCKET env + grant S3 read, still WITHOUT sts/ssm/kms",
    () => {
      const tpl = synthDispatcherWithBucket();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({ COORDINATION_PLUGIN_BUCKET: Match.anyValue() }),
          }),
        }),
      );
      const actions = allActions(tpl);
      expect(actions.some((a) => a.startsWith("s3:Get"))).toBe(true);
      expect(actions).toContain("dynamodb:Query");
      expect(actions).not.toContain("sts:AssumeRole");
      expect(actions).not.toContain("ssm:GetParameter");
      expect(actions).not.toContain("kms:Decrypt");
    },
    SYNTH_TIMEOUT_MS,
  );
});
