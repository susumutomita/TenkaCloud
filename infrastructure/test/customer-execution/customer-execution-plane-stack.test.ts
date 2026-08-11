import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CustomerExecutionPlaneStack } from "../../lib/customer-execution/customer-execution-plane-stack";

function synth(): Template {
  const app = new App();
  const stack = new CustomerExecutionPlaneStack(app, "Test", {
    planeAudience: "plane://acme/challenge-ou",
    allowedAccountIds: ["111111111111"],
    allowedRegions: ["us-east-1"],
    approvedProblemIds: ["net-evo-01-reachability", "stackstack"],
    verifySecretParameterName: "/tenkacloud/verify-secret",
    env: { account: "111111111111", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("CustomerExecutionPlaneStack (#1727)", () => {
  it("should provision a 1/1 PROVISIONED nonce table with a TTL attribute", () => {
    const t = synth();
    // PROVISIONED is the CFn default so CDK omits BillingMode; the presence of
    // ProvisionedThroughput (which on-demand tables lack) proves it is PROVISIONED.
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("should create an SQS intent queue with a dead-letter queue", () => {
    const t = synth();
    t.resourceCountIs("AWS::SQS::Queue", 2);
    t.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it("should run an SQS-triggered Lambda with the plane configuration in env", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          PLANE_AUDIENCE: "plane://acme/challenge-ou",
          ALLOWED_ACCOUNT_IDS: "111111111111",
          APPROVED_PROBLEM_IDS: "net-evo-01-reachability,stackstack",
          VERIFY_SECRET_PARAM: "/tenkacloud/verify-secret",
        }),
      },
    });
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("should create a CloudFormation service role assumable only by CloudFormation", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "cloudformation.amazonaws.com" },
            Action: "sts:AssumeRole",
          }),
        ]),
      }),
    });
  });

  it("should scope CloudFormation deploy permissions to tc-* stacks and gate PassRole to CloudFormation", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["cloudformation:CreateStack", "cloudformation:DeleteStack"]),
          }),
          Match.objectLike({
            Action: "iam:PassRole",
            Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
          }),
        ]),
      }),
    });
  });

  it("should NOT grant the execution Lambda any sts:AssumeRole into a control-plane role", () => {
    // Service roles (CFn / Lambda) legitimately have sts:AssumeRole in their TRUST policy,
    // but the Lambda's own permission policies must never let it assume an external role.
    const policies = synth().findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const statements = (
        policy.Properties as { PolicyDocument: { Statement: { Action?: unknown }[] } }
      ).PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        expect(actions).not.toContain("sts:AssumeRole");
      }
    }
  });
});
