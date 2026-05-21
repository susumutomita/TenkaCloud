import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ChallengePayloadStack } from "../lib/challenge-payload/challenge-payload-stack.js";

/**
 * ADR-003 Phase 2: ChallengePayloadStack の CFn snapshot test。
 * deploy 順序の主要 invariant を pin:
 *   - S3 bucket は versioned + SSL only + public access block
 *   - IAM Role は GitHub OIDC sub claim を branch ref で限定 (= 他 repo / 他 branch から
 *     AssumeRole されない)
 *   - Bucket policy が Role に PutObject + PutObjectAcl を許可
 */

function synth(props?: {
  existingOidc?: boolean;
  branches?: readonly string[];
  bucketName?: string;
  githubRepository?: string;
}) {
  const app = new App();
  const stack = new ChallengePayloadStack(app, "Test", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    environmentName: "development",
    bucketName: props?.bucketName ?? "tc-challenges-development",
    githubRepository: props?.githubRepository ?? "susumutomita/TenkaCloudChallenge",
    githubBranches: props?.branches ?? ["main"],
    ...(props?.existingOidc
      ? {
          existingOidcProviderArn:
            "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
        }
      : {}),
  });
  return Template.fromStack(stack);
}

describe("ChallengePayloadStack", () => {
  it("should create a versioned, SSL-only, block-all-public S3 bucket with the requested name", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "tc-challenges-development",
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          },
        ],
      },
    });
    // SSL only is enforced via bucket policy with aws:SecureTransport == false denied
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("should create a GitHub OIDC provider when no ARN is imported", () => {
    const t = synth();
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
  });

  it("should import an existing OIDC provider when ARN is supplied", () => {
    const t = synth({ existingOidc: true });
    t.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
  });

  it("should restrict the IAM Role trust to the configured repo + branch refs", () => {
    const t = synth({ branches: ["main"] });
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              }),
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub":
                  "repo:susumutomita/TenkaCloudChallenge:ref:refs/heads/main",
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should grant PutObject to the publish Role on the catalog bucket", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  it("should emit Outputs for the bucket name and publish role ARN", () => {
    const t = synth();
    t.hasOutput("BucketNameOutput", { Value: Match.anyValue() });
    t.hasOutput("PublishRoleArnOutput", { Value: Match.anyValue() });
  });

  it("should accept multiple branches in the sub claim", () => {
    const t = synth({ branches: ["main", "release"] });
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                "token.actions.githubusercontent.com:sub": [
                  "repo:susumutomita/TenkaCloudChallenge:ref:refs/heads/main",
                  "repo:susumutomita/TenkaCloudChallenge:ref:refs/heads/release",
                ],
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("should throw when githubBranches is empty (= would otherwise produce an unrestricted trust policy)", () => {
    expect(() =>
      synth({
        branches: [],
      }),
    ).toThrow(/at least one entry/);
  });
});
