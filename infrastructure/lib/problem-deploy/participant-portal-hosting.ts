import * as path from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import {
  Distribution,
  HttpVersion,
  OriginAccessIdentity,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export type ParticipantPortalMode = "dev-mock" | "backend";

export interface ParticipantPortalRuntimeConfig {
  /**
   * Portal backend (PR-H2 で立てる Lambda Function URL) の base URL。
   * mode="dev-mock" のときは frontend が呼ばないので空文字 OK。
   */
  readonly apiBaseUrl?: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  /**
   * "dev-mock": frontend 単体動作 (auth 偽装)。"backend": 実 backend を呼ぶ。
   * Portal backend が無い段階では "dev-mock" に倒す。
   */
  readonly mode: ParticipantPortalMode;
}

/**
 * 競技者向け Participant Portal を S3 + CloudFront で配信する Construct。
 *
 * 構造は ApplicationAdminConsoleHosting と同等 (S3 private + OAI + CloudFront +
 * SPA fallback)。dist 供給は build pipeline (`bun run --cwd apps/participant-portal
 * build` が `apps/participant-portal/dist` に出力) が担当。
 *
 * runtime-config.json は portal backend (PR-H2) が確定してから
 * `deployRuntimeConfig()` で配置する。
 */
export class ParticipantPortalHosting extends Construct {
  public readonly distributionDomainName: string;
  public readonly distributionUrl: string;
  private readonly bucket: Bucket;
  private readonly distribution: Distribution;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new Bucket(this, "SiteBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new OriginAccessIdentity(this, "OAI");
    this.bucket.grantRead(oai);

    this.distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new S3Origin(this.bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    this.distributionDomainName = this.distribution.distributionDomainName;
    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;

    const distDir = path.join(__dirname, "..", "..", "..", "apps", "participant-portal", "dist");
    new BucketDeployment(this, "SiteDeployment", {
      sources: [Source.asset(distDir)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: false,
    });
  }

  deployRuntimeConfig(props: ParticipantPortalRuntimeConfig): void {
    new BucketDeployment(this, "RuntimeConfigDeployment", {
      sources: [
        Source.jsonData("runtime-config.json", {
          apiBaseUrl: (props.apiBaseUrl ?? "").replace(/\/$/, ""),
          eventTitle: props.eventTitle,
          eventRegion: props.eventRegion,
          mode: props.mode,
        }),
      ],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/runtime-config.json"],
      prune: false,
    });
  }
}
