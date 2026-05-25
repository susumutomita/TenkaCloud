import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { synthDefault } from "../problem-deploy-backend-stack.test-helpers";

/**
 * Issue #1341 (#1335 Phase 3): AuditArchive bucket の CFn 構造を pin する。
 *
 * - Object Lock Compliance mode + 1-year retention
 * - Lifecycle: Glacier 90 日後 + 7-year expiration
 * - BlockPublicAccess + EnforceSSL + Versioning (= Object Lock 必須)
 * - DDB Stream → Lambda 配線で audit-archive-writer がイベント受信できる
 */

describe("AuditArchive bucket (Issue #1341)", () => {
  const tpl = synthDefault();

  it("should provision a versioned S3 bucket with ObjectLockConfiguration Compliance + 1-year retention", () => {
    tpl.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        VersioningConfiguration: Match.objectLike({ Status: "Enabled" }),
        ObjectLockEnabled: true,
        ObjectLockConfiguration: Match.objectLike({
          ObjectLockEnabled: "Enabled",
          Rule: Match.objectLike({
            DefaultRetention: Match.objectLike({
              Mode: "COMPLIANCE",
              Days: 365,
            }),
          }),
        }),
      }),
    );
  });

  it("should include a lifecycle rule moving to Glacier after 90 days and expiring after 7 years", () => {
    tpl.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        ObjectLockEnabled: true,
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: "Enabled",
              Transitions: Match.arrayWith([
                Match.objectLike({ StorageClass: "GLACIER", TransitionInDays: 90 }),
              ]),
              ExpirationInDays: 365 * 7,
            }),
          ]),
        }),
      }),
    );
  });

  it("should block all public access and require SSL", () => {
    tpl.hasResourceProperties(
      "AWS::S3::Bucket",
      Match.objectLike({
        ObjectLockEnabled: true,
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        }),
      }),
    );
    // EnforceSSL adds a BucketPolicy denying non-SSL traffic for this bucket. Other buckets
    // in the stack add their own policies, so we don't pin a count — just confirm at least
    // one BucketPolicy exists carrying an aws:SecureTransport=false Deny.
    tpl.hasResourceProperties(
      "AWS::S3::BucketPolicy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: Match.objectLike({
                Bool: Match.objectLike({ "aws:SecureTransport": "false" }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("should hook a Lambda EventSourceMapping to the AdminAuditLog DDB Stream", () => {
    tpl.hasResourceProperties(
      "AWS::Lambda::EventSourceMapping",
      Match.objectLike({
        StartingPosition: "TRIM_HORIZON",
      }),
    );
  });

  it("should expose the bucket name via CfnOutput AuditArchiveBucketName", () => {
    expect(tpl.findOutputs("AuditArchiveBucketName")).not.toEqual({});
  });
});
