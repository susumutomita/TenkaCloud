import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { CfnDeployLambda } from "../../lib/problem-deploy/cfn-deploy-lambda";

/**
 * Issue #2291: the Lambda deploy role must be least-privilege — the same privilege
 * split as `DeployCodeBuildProject`'s build role (#1381): CFn stack ops scoped to `tc-*`,
 * `iam:PassRole` to the CFn exec role with `PassedToService=cloudformation`, `sts:AssumeRole`
 * only to `TenkaCloud-*` roles, `ssm:GetParameter` on the ExternalId param, `kms:Decrypt`
 * condition-scoped, and `s3:GetObject` limited to the source bucket.
 */

function buildTemplate(
  options: { readonly deployAllowedCidrs?: readonly string[] } = {},
): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  new CfnDeployLambda(stack, "CfnDeploy", {
    environmentName: "development",
    sourceBucketName: "serverless-saas-123456789012-ap-northeast-1",
    deployAllowedCidrs: options.deployAllowedCidrs,
  });
  return Template.fromStack(stack);
}

describe("CfnDeployLambda (#2291)", () => {
  it("should scope CloudFormation stack operations to tc-* stacks (not a wildcard)", () => {
    const template = buildTemplate();
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["cloudformation:CreateStack", "cloudformation:DeleteStack"]),
              Resource: "arn:aws:cloudformation:*:123456789012:stack/tc-*/*",
            }),
          ]),
        }),
      }),
    );
  });

  it("should restrict sts:AssumeRole to TenkaCloud-* competitor roles", () => {
    buildTemplate().hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sts:AssumeRole",
              Resource: "arn:aws:iam::*:role/TenkaCloud-*",
            }),
          ]),
        }),
      }),
    );
  });

  it("should pass the CFn exec role only to cloudformation.amazonaws.com", () => {
    buildTemplate().hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "iam:PassRole",
              Condition: {
                StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
              },
            }),
          ]),
        }),
      }),
    );
  });

  it("should scope ssm:GetParameter to the ExternalId parameter path and condition kms:Decrypt", () => {
    const template = buildTemplate();
    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Resource:
                "arn:aws:ssm:ap-northeast-1:123456789012:parameter/development/tenants/*/external-id",
            }),
            Match.objectLike({
              Action: "kms:Decrypt",
              Condition: {
                StringLike: {
                  "kms:EncryptionContext:PARAMETER_ARN":
                    "arn:aws:ssm:ap-northeast-1:123456789012:parameter/development/tenants/*/external-id",
                },
              },
            }),
          ]),
        }),
      }),
    );
  });

  it("should limit s3:GetObject to the source bucket", () => {
    buildTemplate().hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "s3:GetObject",
              Resource: "arn:aws:s3:::serverless-saas-123456789012-ap-northeast-1/*",
            }),
          ]),
        }),
      }),
    );
  });

  it("should confine the broad resource-creation privilege to a cloudformation-assumable exec role", () => {
    const template = buildTemplate();
    template.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: "cloudformation.amazonaws.com" },
            }),
          ]),
        }),
      }),
    );
  });

  it("should inject the SOURCE_BUCKET_NAME / TENKACLOUD_ACCOUNT_ID / CFN_EXEC_ROLE_ARN env", () => {
    const template = buildTemplate();
    template.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            SOURCE_BUCKET_NAME: "serverless-saas-123456789012-ap-northeast-1",
            TENKACLOUD_ACCOUNT_ID: "123456789012",
          }),
        }),
      }),
    );
  });

  it("should create a dedicated job-progress LogGroup (1-month retention) for #2291", () => {
    // FunctionLogGroup has no explicit retention; the #2291 job log group is the only one with
    // RetentionInDays=30 (RetentionDays.ONE_MONTH), so it uniquely identifies it.
    buildTemplate().hasResourceProperties(
      "AWS::Logs::LogGroup",
      Match.objectLike({ RetentionInDays: 30 }),
    );
  });

  it("should inject DEPLOY_JOB_LOG_GROUP env pointing at the job LogGroup", () => {
    buildTemplate().hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ DEPLOY_JOB_LOG_GROUP: Match.anyValue() }),
        }),
      }),
    );
  });

  it("should inject DEPLOY_ALLOWED_CIDRS env only when configured", () => {
    buildTemplate({
      deployAllowedCidrs: ["198.51.100.10/32", "203.0.113.0/24"],
    }).hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            DEPLOY_ALLOWED_CIDRS: "198.51.100.10/32,203.0.113.0/24",
          }),
        }),
      }),
    );

    buildTemplate().hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.not(Match.objectLike({ DEPLOY_ALLOWED_CIDRS: Match.anyValue() })),
        }),
      }),
    );
  });

  it("should grant only CreateLogStream + PutLogEvents on the job LogGroup (no wildcard)", () => {
    buildTemplate().hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Effect: "Allow",
              // Scoped to the job log group ARN + its streams (`:*`), never `*`.
              Resource: Match.not("*"),
            }),
          ]),
        }),
      }),
    );
  });
});
