import { IgnoreMode, RemovalPolicy } from "aws-cdk-lib";
import { Distribution, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

/** Two existing SPAs, S3 origin access control, and runtime configuration; no separate SaaS UI. */
export class CloudHosting extends Construct {
  readonly bucket: Bucket;
  readonly distribution: Distribution;
  readonly url: string;
  constructor(scope: Construct, id: string, assetPath: string) {
    super(scope, id);
    // eslint-disable-next-line sonarjs/aws-s3-bucket-versioning -- This bucket contains rebuildable published SPA assets only; persistent event/identity records are retained separately.
    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.distribution = new Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
      })),
    });
    new BucketDeployment(this, "Assets", {
      sources: [
        Source.asset(assetPath, { exclude: [".env*", ".git"], ignoreMode: IgnoreMode.GIT }),
      ],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      retainOnDelete: false,
      prune: false,
    });
    this.url = `https://${this.distribution.distributionDomainName}`;
  }
}
