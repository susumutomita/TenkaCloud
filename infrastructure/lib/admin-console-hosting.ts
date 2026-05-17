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
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { buildSecurityHeadersPolicy } from "./security/cloudfront-headers";

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
  /**
   * Admin Insight API のエンドポイント (ADR-011 / #590 Phase 1.A)。System Admin が
   * tenant 横断で deploy 進捗を read する経路。phase 1.A では tenant 一覧の deploy 集計 column
   * (= activeDeploys / failedDeploys) を表示するのに使う。
   *
   * 空文字 fallback は admin-console 側で「未発行」表示にしてリクエスト送信をスキップする
   * (= phase 2 初回 deploy の race 状態でも UI が壊れない安全装置)。
   */
  readonly adminInsightApiUrl: string;
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
  /**
   * #718: CFn `TemplateURL` は S3 / SSM の URL しか受け付けない (raw.githubusercontent.com は
   * reject)。 競技者の Quick-create / Update Stack 経路で fetch される
   * `competitor-bootstrap.yaml` の S3 public URL。 admin-console の runtime-config.json に
   * 注入され、 frontend の `buildLaunchStackUrl` / `buildUpdateStackUrl` が consumer。
   */
  public readonly competitorBootstrapTemplateUrl: string;

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

    // Issue #855 + #896 + #899: CloudFront に security headers (HSTS / CSP / X-Frame-Options 等)
    // を強制。 admin-console は次の経路に fetch する:
    //   - props.apiUrl              : Control Plane API GW (= tenant CRUD)
    //   - props.cognitoDomain       : Cognito OAuth (/oauth2/token /authorize /revoke /logout)
    //   - props.adminInsightApiUrl  : AdminInsight API GW (= Provisioning Jobs / TenantDrillDown)
    //   - cdn.jsdelivr.net          : Issue #899 — Scalar API reference を CDN から読み込む
    //                                 (public/api-docs.html、 SPA bundle に混ぜない方針)
    // form-action は Cognito Hosted UI への sign-in form 投稿で使う。
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [props.apiUrl, props.cognitoDomain, props.adminInsightApiUrl],
      formActionAllowedOrigins: [props.cognitoDomain],
      additionalScriptSrcs: ["https://cdn.jsdelivr.net"],
    });

    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        // CDK 2.252+ で `S3Origin` は deprecated。 `S3BucketOrigin.withOriginAccessIdentity` は
        // 既存 OAI を渡せる同等 API (= bucket policy + Signer 経路を変えずに移行可)。 OAC への
        // 完全移行は別 PR で trade-off (= 既存 deploy stack の OAI を OAC に置換する操作) を含めて扱う。
        origin: S3BucketOrigin.withOriginAccessIdentity(bucket, { originAccessIdentity: oai }),
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

    this.distributionDomainName = distribution.distributionDomainName;

    // #718: 競技者向け CFn template の public S3 host。 CFn `TemplateURL` は S3 URL のみ
    // 許容するため、 GitHub raw URL の代わりに本 bucket の virtual-hosted style URL を返す。
    // template 自体は既に public repo に置いてあり secret は含まないので、 public-read ACL
    // は OK (= content は GitHub と冗長な複製)。 admin-console の runtime-config 経由で
    // frontend に渡し、 Quick-create / Update Stack deeplink の templateURL に埋める。
    const templateBucket = new Bucket(this, "CompetitorBootstrapTemplateBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // public-read を明示的に許可するため BlockPublicAccess を全 OFF にする。 BucketPolicy
      // / ACL を後段で `publicReadAccess: true` で付与する。 同 stack 内の SiteBucket は
      // BLOCK_ALL のまま (= 別 bucket 分離 + 1 bucket = 1 用途で混在を避ける)。
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CompetitorAccounts modal の Launch Stack / Update Stack で参照される yaml を S3 へ sync。
    // ローカル checkout の最新 yaml を deploy 時に upload するため、 GitHub raw と異なり
    // PR 後の merge → 再 deploy で competitor 側にも反映される。
    new BucketDeployment(this, "CompetitorBootstrapTemplateDeployment", {
      sources: [
        Source.asset(path.join(__dirname, "..", "templates"), {
          // テンプレ単一 file のみ upload (= templates/ ディレクトリ内の README 等は不要)
          exclude: ["*", "!competitor-bootstrap.yaml"],
        }),
      ],
      destinationBucket: templateBucket,
      prune: false,
    });

    // virtual-hosted style S3 URL (= CFn TemplateURL が要求する形式)。 region は明示的に
    // path に含める。 同 stack 配下の bucketName は CFn deploy 時に動的解決される。
    this.competitorBootstrapTemplateUrl = `https://${templateBucket.bucketName}.s3.${cdk.Stack.of(this).region}.amazonaws.com/competitor-bootstrap.yaml`;

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
      // ADR-011 #590 Phase 1.A
      adminInsightApiUrl: props.adminInsightApiUrl.replace(/\/$/, ""),
      // #718: 競技者向け bootstrap template の public S3 URL (CFn TemplateURL 経由 fetch 用)
      competitorBootstrapTemplateUrl: this.competitorBootstrapTemplateUrl,
    };
    // Issue #867: runtime-config.json は **絶対にキャッシュさせない** (= CloudFront edge で
    // tenant 間混線するリスク + deploy 後 1 時間反映されない問題を避けるため)。
    new BucketDeployment(this, "RuntimeConfigDeployment", {
      sources: [Source.jsonData("runtime-config.json", runtimeConfig)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/runtime-config.json"],
      prune: false,
      cacheControl: [CacheControl.noStore(), CacheControl.noCache(), CacheControl.mustRevalidate()],
    });

    new cdk.CfnOutput(this, "AdminConsoleUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description:
        "admin-console の CloudFront URL。ControlPlaneStack の CDK_PARAM_ADMIN_CONSOLE_ORIGIN に設定して再 deploy することで Cognito callback + CORS に追加される",
    });

    new cdk.CfnOutput(this, "CompetitorBootstrapTemplateUrl", {
      value: this.competitorBootstrapTemplateUrl,
      description:
        "Competitor 用 bootstrap CFn テンプレート (= competitor-bootstrap.yaml) の S3 public URL。Quick-create / Update Stack deeplink の TemplateURL に渡す。",
    });
  }
}
