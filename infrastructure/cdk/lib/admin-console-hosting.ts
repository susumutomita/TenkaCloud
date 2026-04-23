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
}

/**
 * client/AdminWeb (Next.js) を CloudFront + S3 で配信する stack。
 *
 * ⚠️ ARCHITECTURE MISMATCH: TenkaCloud の AdminWeb は `output: 'standalone'` で
 *    `/api/auth/[...nextauth]` 等の API routes を持つため、pure S3+CloudFront
 *    では動かない (server runtime が必要)。本 stack はリファレンス実装として残しているが、
 *    実運用では serverless 前提を守るため以下のいずれかへ移行する:
 *      - OpenNext で Lambda@Edge / Lambda にデプロイ
 *      - AWS Amplify Hosting (Next.js SSR サポート)
 *    INVARIANT_SERVERLESS_ONLY を守るため、常駐 compute (コンテナオーケストレータ系) は選択肢から除外する。
 *    詳細は ADR-013 参照。
 *
 * 既存設計 (Vite/SPA 想定で残してある部分):
 * - dist/ は install.sh が host 側で build
 * - URL 系 (API / Cognito) は build artifact に焼かず、`runtime-config.json` として別途
 *   S3 にアップロード → AdminWeb は起動時に `/runtime-config.json` を fetch して URL を解決
 *
 * 3-phase deploy の phase 2:
 *   1. ControlPlaneStack が立っている
 *   2. install.sh が client/AdminWeb を build → 本 stack を deploy
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
    // ⚠️ 上記コメント参照 — Next.js standalone との不整合は未解決。
    //    install.sh で `client/AdminWeb` の build artifact を `client/AdminWeb/dist/` に
    //    出力する暫定運用を想定。
    const distDir = path.join(__dirname, "..", "..", "client", "AdminWeb", "dist");
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
        "AdminWeb の CloudFront URL。ControlPlaneStack の CDK_PARAM_ADMIN_CONSOLE_ORIGIN に設定して再 deploy することで Cognito callback + CORS に追加される",
    });
  }
}
