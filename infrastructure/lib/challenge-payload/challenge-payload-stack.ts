import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * Publishes problem catalog payloads without coupling the catalog repository to deployment.
 *
 * S3 bucket + GitHub OIDC IAM Role を立てる stack。 TenkaCloudChallenge repo の
 * `.github/workflows/publish.yml` がこの Role を AssumeRole して、 変更があった
 * problem dir を `s3://<bucket>/<problemId>/<sha>.zip` (+ `latest.zip`) にアップロード。
 * deploy-handler は ProblemDeployBackendStack の `challengePayloadBucketName` 経由で
 * この bucket から 15min TTL presigned URL を発行する。
 *
 * stack を deploy したら Output:
 *   - `BucketName` を TenkaCloudChallenge repo の `vars` に bind (= 表示用、 secret 不要)
 *   - `PublishRoleArn` を TenkaCloudChallenge repo の `secrets.AWS_CHALLENGE_PUBLISH_ROLE_ARN` に bind
 * その後 publish.yml の main push trigger が動作開始する。
 */
export interface ChallengePayloadStackProps extends cdk.StackProps {
  readonly environmentName: string;
  readonly bucketName: string;
  /** 例 `"susumutomita/TenkaCloudChallenge"`。 OIDC sub claim 検証で使う。 */
  readonly githubRepository: string;
  /** AssumeRole を許可する branch ref 一覧。 default `["main"]`。 */
  readonly githubBranches?: readonly string[];
  /**
   * 既存の GitHub OIDC provider ARN。 AWS account に既に存在する場合は import する
   * (= 1 account に同 URL の OIDC provider は 1 つしか作れない)。 未指定なら本 stack
   * が新規作成する。
   */
  readonly existingOidcProviderArn?: string;
  /** Noncurrent S3 object を削除するまでの日数 (default 30)。 */
  readonly noncurrentExpirationDays?: number;
}

export class ChallengePayloadStack extends cdk.Stack {
  public readonly bucketName: string;
  public readonly publishRoleArn: string;

  constructor(scope: Construct, id: string, props: ChallengePayloadStackProps) {
    super(scope, id, props);

    const branches = props.githubBranches ?? ["main"];
    if (branches.length === 0) {
      throw new Error("ChallengePayloadStack: githubBranches must contain at least one entry");
    }

    const bucket = new s3.Bucket(this, "Bucket", {
      bucketName: props.bucketName,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(props.noncurrentExpirationDays ?? 30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    const oidcProvider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "GithubOidc",
          props.existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, "GithubOidc", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    const subClaims = branches.map(
      (branch) => `repo:${props.githubRepository}:ref:refs/heads/${branch}`,
    );

    const principal = new iam.OpenIdConnectPrincipal(oidcProvider, {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub":
          subClaims.length === 1 ? subClaims[0] : subClaims,
      },
    });

    const role = new iam.Role(this, "PublishRole", {
      assumedBy: principal,
      description: `Publish role for ${props.githubRepository} -> ${bucket.bucketName}. S3 payload publication only.`,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    bucket.grantPut(role);

    this.bucketName = bucket.bucketName;
    this.publishRoleArn = role.roleArn;

    new cdk.CfnOutput(this, "BucketNameOutput", {
      value: bucket.bucketName,
      description:
        "S3 bucket name that holds per-problem zip payloads. Set as `var` in TenkaCloudChallenge repo.",
    });
    new cdk.CfnOutput(this, "PublishRoleArnOutput", {
      value: role.roleArn,
      description:
        "OIDC publish Role ARN. Bind to TenkaCloudChallenge repo secret AWS_CHALLENGE_PUBLISH_ROLE_ARN.",
    });
  }
}
