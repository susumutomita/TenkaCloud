import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import {
  Distribution,
  HttpVersion,
  OriginAccessIdentity,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import {
  buildCustomDomainDistributionProps,
  type CustomDomainConfig,
} from "./security/cloudfront-custom-domain.js";
import { buildSecurityHeadersPolicy } from "./security/cloudfront-headers.js";

/**
 * Issue #1031: admin-console-hosting は **CloudFront 配信側だけ** を担い、 runtime-config.json
 * の生成は `AdminConsoleRuntimeConfigStack` に分離した。 これにより依存方向を 1 方向
 * (= 本 stack → control-plane / admin-console-insight → runtime-config) に揃え、
 * `bun cdk deploy --all` 1 発で install.sh が完結する。
 *
 * CSP は backend URL を **wildcard pattern** で許可する。 これによりバックエンド URL の
 * cross-stack ref を本 stack から外して循環依存を解消する。 trade-off:
 *   - 旧: `<specific-execute-api-id>.execute-api.<region>.amazonaws.com` を厳密 allow
 *   - 新: `https://*.execute-api.<region>.amazonaws.com` で region 内全 API GW を allow
 * 同 region 別 API GW を悪用するには (a) admin-console XSS 注入 (b) 同 account に攻撃 API 所持 の
 * 両条件が要り、 hosting 単独 deploy 可能性を取って良い trade。
 *
 * 旧 admin-console-hosting にあった `competitor-bootstrap.yaml` の S3 host は Issue #1053 で
 * ProblemDeployBackendStack 配下に移管済。
 */
export interface AdminConsoleHostingStackProps extends cdk.StackProps {
  /**
   * Issue #1695: opt-in のカスタムドメイン + ACM 証明書。 設定時のみ TLS 1.2 を強制する
   * (= `minimumProtocolVersion = TLS_V1_2_2021`)。 未設定なら default 証明書配信のまま (NO-OP)。
   */
  readonly customDomain?: CustomDomainConfig;
}

export class AdminConsoleHostingStack extends cdk.Stack {
  public readonly distributionDomainName: string;
  /**
   * Issue #1031: `AdminConsoleRuntimeConfigStack` が runtime-config.json をこの bucket に
   * BucketDeployment する。 cross-stack ref で受け渡す。
   */
  public readonly siteBucket: Bucket;
  /**
   * Issue #1031: runtime-config.json 更新時の CloudFront 無効化 (= `distributionPaths`) 用。
   */
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: AdminConsoleHostingStackProps) {
    super(scope, id, props);

    this.siteBucket = new Bucket(this, "SiteBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new OriginAccessIdentity(this, "OAI");
    this.siteBucket.grantRead(oai);

    // Issue #1031: CSP は region wildcard。 詳細は file header 参照。
    const region = cdk.Stack.of(this).region;
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        `https://*.execute-api.${region}.amazonaws.com`,
        "https://*.amazoncognito.com",
        `https://cognito-idp.${region}.amazonaws.com`,
      ],
      formActionAllowedOrigins: ["https://*.amazoncognito.com"],
    });

    this.distribution = new Distribution(this, "Distribution", {
      // Issue #1695: customDomain 設定時のみ domainNames + ACM 証明書 + TLS 1.2 強制。 未設定は NO-OP。
      ...buildCustomDomainDistributionProps(this, "ViewerCertificate", props.customDomain),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(this.siteBucket, {
          originAccessIdentity: oai,
        }),
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

    // dist/ をアップロード (URL 非依存の静的ファイル)
    const distDir = path.join(import.meta.dirname, "..", "..", "apps", "admin-console", "dist");
    new BucketDeployment(this, "SiteDeployment", {
      sources: [Source.asset(distDir)],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      prune: false, // runtime-config.json は別 stack が書くので他 key を残す
    });

    new cdk.CfnOutput(this, "AdminConsoleUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description:
        "admin-console の CloudFront URL。 control-plane / admin-console-insight に cross-stack ref で渡る (= callback / CORS 経路で消費)",
    });
  }
}
