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
import { buildSecurityHeadersPolicy } from "../security/cloudfront-headers";

export type ParticipantPortalMode = "dev-mock" | "backend";

export interface ParticipantPortalRuntimeConfig {
  /**
   * Portal backend (Lambda Function URL) の base URL。
   * mode="dev-mock" のときは frontend が呼ばないので空文字 OK。
   */
  readonly apiBaseUrl?: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  /**
   * "dev-mock": frontend 単体動作 (auth 偽装)。"backend": 実 backend を呼ぶ。
   */
  readonly mode: ParticipantPortalMode;
}

const DEFAULT_DEV_MOCK_RUNTIME_CONFIG = (region: string): ParticipantPortalRuntimeConfig => ({
  eventTitle: "TenkaCloud Battle",
  eventRegion: region,
  mode: "dev-mock",
});

/**
 * 競技者向け Participant Portal を S3 + CloudFront で配信する Construct。
 *
 * 構造は ApplicationAdminConsoleHosting と同等 (S3 private + OAI + CloudFront +
 * SPA fallback)。dist 供給は build pipeline (`bun run --cwd apps/participant-portal
 * build` が `apps/participant-portal/dist` に出力) が担当。
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

    // Issue #855: CloudFront に security headers を強制。 participant-portal は teamLoginKey 経路
    // (= bearer token 専用) で外部 Cognito は使わないが、 backend API (= Lambda Function URL)
    // への connect は許可する必要がある。 form-action は teamLoginKey login の form 投稿で同 origin。
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        "https://*.lambda-url.*.on.aws",
        "https://*.execute-api.*.amazonaws.com",
      ],
    });

    this.distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new S3Origin(this.bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
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

  deployRuntimeConfig(config: ParticipantPortalRuntimeConfig): void {
    new BucketDeployment(this, "RuntimeConfigDeployment", {
      sources: [
        Source.jsonData("runtime-config.json", {
          apiBaseUrl: (config.apiBaseUrl ?? "").replace(/\/$/, ""),
          eventTitle: config.eventTitle,
          eventRegion: config.eventRegion,
          mode: config.mode,
        }),
      ],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/runtime-config.json"],
      prune: false,
    });
  }
}

export { DEFAULT_DEV_MOCK_RUNTIME_CONFIG };
