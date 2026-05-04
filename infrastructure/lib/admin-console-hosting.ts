import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
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
import type { Construct } from "constructs";

export interface AdminConsoleHostingStackProps extends cdk.StackProps {
  /** Control Plane API Gateway URL (末尾スラッシュ無し) */
  readonly apiUrl: string;
  /** Cognito UserPool domain (例: https://xxx.auth.<region>.amazoncognito.com) */
  readonly cognitoDomain: string;
  /** SBT 内蔵 UserPoolUserClient の client ID */
  readonly userClientId: string;
  /**
   * Pooled tier tenants が共有する application-admin-console の CloudFront URL。
   * admin-console の TenantList で basic / advanced tenant 行のリンクに使う。
   */
  readonly pooledApplicationAdminConsoleUrl: string;
  /**
   * Provisioning ジョブを動かす CodeBuild project 名 (SBT BashJobRunner が立てる)。
   * admin-console の「ログ」カラムで build deep link の構築に使う。
   * unknown なら admin-console 側はリンクを出さない。
   */
  readonly provisioningCodeBuildProject: string;
  /**
   * AWS region (例: ap-northeast-1)。CodeBuild console URL の {region} に埋める。
   */
  readonly awsRegion: string;
  /**
   * AWS account ID。CodeBuild console URL の {accountId} に埋める。
   */
  readonly awsAccountId: string;
}

/**
 * apps/admin-console (React + Vite) を CloudFront + S3 で配信する stack。
 *
 * 設計:
 * - dist/ は install.sh が host 側で build (bun workspace の symlink を docker cp が扱えない問題回避)
 * - URL 系 (API / Cognito) は build artifact に焼かず、`runtime-config.json` として別途 S3 にアップロード
 *   admin-console は起動時に `/runtime-config.json` を fetch して URL を解決する
 *   → build artifact は URL 非依存、backend URL が変わっても再 build 不要
 *
 * 3-phase deploy の phase 2:
 *   1. ControlPlaneStack が立っている
 *   2. install.sh が apps/admin-console を build → 本 stack を deploy
 *      (S3 アップロード: dist/ + runtime-config.json、CloudFront 作成)
 *   3. ControlPlaneStack を再 deploy して CloudFront URL を callback / CORS に追加
 */
export class AdminConsoleHostingStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: AdminConsoleHostingStackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, "SiteBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new OriginAccessIdentity(this, "OAI");
    bucket.grantRead(oai);

    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity: oai }),
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

    this.distributionDomainName = distribution.distributionDomainName;

    // 1) dist/ をアップロード (URL 非依存の静的ファイル)
    const distDir = path.join(__dirname, "..", "..", "apps", "admin-console", "dist");
    new BucketDeployment(this, "SiteDeployment", {
      sources: [Source.asset(distDir)],
      destinationBucket: bucket,
      distribution,
      prune: false, // runtime-config.json を別途配置するので他 key も残す
    });

    // 2) runtime-config.json を同 bucket のルートに配置
    // admin-console は起動時に `/runtime-config.json` を fetch して URL を解決する
    const runtimeConfig = {
      apiUrl: props.apiUrl.replace(/\/$/, ""),
      cognitoDomain: props.cognitoDomain,
      userClientId: props.userClientId,
      pooledApplicationAdminConsoleUrl: props.pooledApplicationAdminConsoleUrl,
      provisioningCodeBuildProject: props.provisioningCodeBuildProject,
      awsRegion: props.awsRegion,
      awsAccountId: props.awsAccountId,
    };
    new BucketDeployment(this, "RuntimeConfigDeployment", {
      sources: [Source.jsonData("runtime-config.json", runtimeConfig)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/runtime-config.json"],
      prune: false,
    });

    new cdk.CfnOutput(this, "AdminConsoleUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description:
        "admin-console の CloudFront URL。ControlPlaneStack の CDK_PARAM_ADMIN_CONSOLE_ORIGIN に設定して再 deploy することで Cognito callback + CORS に追加される",
    });
  }
}
