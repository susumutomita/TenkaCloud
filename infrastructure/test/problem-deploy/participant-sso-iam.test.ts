import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { describe, expect, it, vi } from "vitest";
import { ParticipantPortalLambda } from "../../lib/problem-deploy/participant-portal-lambda";
import type { DefineNodejsFunctionProps } from "../../lib/utils/define-nodejs-function";

// IAM and environment contract only; the Lambda bundle is verified by handler tests.
vi.mock("../../lib/utils/define-nodejs-function.js", () => ({
  defineNodejsFunction: (scope: Construct, props: DefineNodejsFunctionProps) =>
    new LambdaFunction(scope, "Function", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
      role: props.role,
      environment: props.environment,
    }),
}));

describe("participant viewer IAM boundary", () => {
  it("grants only canonical roles with ExternalId and supports acknowledged host-account events", () => {
    const app = new App();
    const stack = new Stack(app, "SsoTest", {
      env: { account: "111111111111", region: "ap-northeast-1" },
    });
    const portal = new ParticipantPortalLambda(stack, "Portal", {
      environmentName: "development",
      problemsScoring: {},
      problemsEndpoints: {},
    });
    const template = Template.fromStack(Stack.of(portal));
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    const statements = roles.flatMap(
      (role) =>
        role.Properties.Policies?.flatMap(
          (policy: { PolicyDocument: { Statement: unknown[] } }) => policy.PolicyDocument.Statement,
        ) ?? [],
    );
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: "arn:aws:iam::*:role/tc-*",
      Condition: {
        StringLike: { "sts:ExternalId": "??????????????????????????" },
      },
    });
    // The runtime binds same-account access to a saved event acknowledgment and
    // verified stack ownership; its canonical role grant must remain executable.
    expect(statements).not.toContainEqual(
      expect.objectContaining({ Effect: "Deny", Action: "sts:AssumeRole" }),
    );
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: "arn:aws:iam::*:role/TenkaCloud-*",
      Condition: { StringLike: { "sts:ExternalId": "?*" } },
    });
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource:
        "arn:aws:ssm:ap-northeast-1:111111111111:parameter/development/tenants/*/external-id",
    });
    expect(statements).not.toContainEqual(
      expect.objectContaining({
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/*",
      }),
    );
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { PARTICIPANT_OPERATOR_ACCOUNT_ID: "111111111111" } },
    });
  });
});
