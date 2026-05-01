import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import {
  Distribution,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
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
  /** SBT Control Plane API Gateway URL (末尾スラッシュ無し) — テナント CRUD */
  readonly apiUrl: string;
  /** Cognito UserPool domain (例: https://xxx.auth.<region>.amazoncognito.com) */
  readonly cognitoDomain: string;
  /** SBT 内蔵 UserPoolUserClient の client ID */
  readonly userClientId: string;
  /**
   * AdminApiStack の HTTP API Gateway URL (各 microservice のフロント、Cognito JWT 保護)。
   * 未設定の場合、AdminWeb は SBT API のみ利用 (activities/stats 等は呼べない)。
   */
  readonly adminApiUrl?: string;
}

/**
 * client/AdminWeb (Next.js static export) を CloudFront + S3 で配信する stack。
 *
 * 設計 (ProtoShip ref パターン):
 * - AdminWeb は `output: 'export'` で静的書き出し → `dist/`
 * - 認証は browser-side Cognito PKCE (NextAuth は廃止、ADR 修正予定)
 * - URL 系 (API / Cognito) は build artifact に焼かず、`runtime-config.json` として別途
 *   S3 にアップロード → AdminWeb は起動時に `/runtime-config.json` を fetch して URL を解決
 * - dist/ ディレクトリは install.sh が host 側で build (bun workspace の symlink 問題回避)
 * - SPA fallback: CloudFront errorResponse 404→/index.html で client-side routing に委譲
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

    // Next.js static export は dist/login.html, dist/dashboard.html, dist/callback.html を生成する
    // (trailingSlash:false)。CloudFront の生 URI は /login のように拡張子無しで来るので、S3 が
    // そのキーを持たず 404 になる。errorResponses で /index.html にフォールバックすると home
    // ページの HTML が返されてしまい、Callback ページが読み込まれずログインがループする。
    // CloudFront Function でパスに `.html` を補完して、各ルートが正しい HTML をロードできるようにする。
    const urlRewriter = new CfFunction(this, "UrlRewriter", {
      code: FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  if (uri.endsWith('/')) {
    req.uri = uri + 'index.html';
  } else if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {
    req.uri = uri + '.html';
  }
  return req;
}
      `),
    });

    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: urlRewriter,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: "index.html",
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      errorResponses: [
        // 真に存在しないパスへの fallback。url rewriter で .html 補完しても 404 になる場合は
        // SPA を起動するため index.html を返す (404 ページ用)。
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // 1) dist/ をアップロード (URL 非依存の静的ファイル)。install.sh が host build する。
    const distDir = path.resolve(__dirname, "..", "..", "..", "client", "AdminWeb", "dist");
    new BucketDeployment(this, "SiteDeployment", {
      sources: [Source.asset(distDir)],
      destinationBucket: bucket,
      distribution,
      prune: false, // runtime-config.json を別途配置するので他 key も残す
    });

    // 2) runtime-config.json を同 bucket のルートに配置
    // admin-console は起動時に `/runtime-config.json` を fetch して URL を解決する
    const runtimeConfig: Record<string, string> = {
      apiUrl: props.apiUrl.replace(/\/$/, ""),
      cognitoDomain: props.cognitoDomain,
      userClientId: props.userClientId,
    };
    if (props.adminApiUrl) {
      runtimeConfig.adminApiUrl = props.adminApiUrl.replace(/\/$/, "");
    }
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
