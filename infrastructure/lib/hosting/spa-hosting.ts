import { RemovalPolicy } from "aws-cdk-lib";
import {
  Distribution,
  HttpVersion,
  OriginAccessIdentity,
  PriceClass,
  type ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import {
  buildCustomDomainDistributionProps,
  type CustomDomainConfig,
} from "../security/cloudfront-custom-domain.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";

/**
 * Issue #2207: SPA hosting (S3 private + OAI + CloudFront + SPA fallback + dist deployment) の
 * 共通スキャフォールド。 admin-console / application-admin-console / participant-portal の
 * 3 箇所で byte 同一だった組み立てを 1 実装に集約する。
 *
 * **Construct class ではなく builder 関数** であることが本質 (= `buildAppPlaneCore` と同じ判断)。
 * 呼び出し元の construct を `scope` にし、 子 ID (`SiteBucket` / `OAI` / `ViewerCertificate` /
 * `Distribution` / `SiteDeployment`) を従来と同一に保つことで CFn logical ID を 1 つも動かさない。
 * Construct で包むと path が 1 段増えて全 logical ID が変わり、 S3 bucket (データ) と
 * CloudFront distribution (ドメイン名) が REPLACE される。
 *
 * per-site の差分 (CSP / dist の場所 / portal の runtime-config exclude) は props で残す。
 * CSP の中身は各サイトの脅威モデルに紐づくため、 `securityHeaders` は呼び出し元が
 * `buildSecurityHeadersPolicy` で構築して渡す。
 */
export interface SpaHostingProps {
  /** SPA build 成果物 (index.html を含む dist ディレクトリ) の絶対パス。 */
  readonly distDir: string;
  /** 呼び出し元が `buildSecurityHeadersPolicy(scope, "SecurityHeaders", ...)` で構築した policy。 */
  readonly securityHeaders: ResponseHeadersPolicy;
  /** Issue #1695: opt-in カスタムドメイン + ACM 証明書 (設定時のみ TLS 1.2 強制)。 */
  readonly customDomain?: CustomDomainConfig;
  /** dist から S3 へ上げないファイル (participant-portal の `runtime-config.json` 混入対策)。 */
  readonly sourceExclude?: readonly string[];
  /** SiteDeployment 時に invalidate する CloudFront パス (未指定なら invalidation なし)。 */
  readonly distributionPaths?: readonly string[];
}

export interface SpaHostingResult {
  readonly siteBucket: Bucket;
  readonly distribution: Distribution;
}

export function buildSpaHosting(scope: Construct, props: SpaHostingProps): SpaHostingResult {
  const siteBucket = new Bucket(scope, "SiteBucket", {
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  const oai = new OriginAccessIdentity(scope, "OAI");
  siteBucket.grantRead(oai);

  const distribution = new Distribution(scope, "Distribution", {
    // Issue #1695: customDomain 設定時のみ domainNames + ACM 証明書 + TLS 1.2 強制。 未設定は NO-OP。
    ...buildCustomDomainDistributionProps(scope, "ViewerCertificate", props.customDomain),
    defaultBehavior: {
      origin: S3BucketOrigin.withOriginAccessIdentity(siteBucket, {
        originAccessIdentity: oai,
      }),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: props.securityHeaders,
    },
    defaultRootObject: "index.html",
    httpVersion: HttpVersion.HTTP2,
    priceClass: PriceClass.PRICE_CLASS_100,
    errorResponses: [
      { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
      { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
    ],
  });

  new BucketDeployment(scope, "SiteDeployment", {
    logGroup: spaDeploymentLogGroup(scope),
    sources: [
      props.sourceExclude
        ? Source.asset(props.distDir, { exclude: [...props.sourceExclude] })
        : Source.asset(props.distDir),
    ],
    destinationBucket: siteBucket,
    distribution,
    ...(props.distributionPaths ? { distributionPaths: [...props.distributionPaths] } : {}),
    // runtime-config.json は別 deployment が書くので他 key を消さない
    prune: false,
  });

  return { siteBucket, distribution };
}

/**
 * この scope の `BucketDeployment` provider が使う LogGroup (#2960)。
 *
 * `SiteDeployment` と `RuntimeConfigDeployment` は同じ stack にあるとき同じ provider Lambda を
 * 共有する (`tenant-template-pooled` がその形)。 別々の LogGroup を渡すと効くのは片方だけで、
 * もう片方は誰も使わない log group として stack に残る — 掃除されない resource を減らす変更で
 * 掃除されない resource を増やすことになる。 だから scope ごとに 1 つだけ作って共有する。
 *
 * ID が `SiteDeploymentLogs` ではなく `BucketDeploymentLogs` なのは、 `runtime-config` だけを
 * 配る stack (`admin-console-runtime-config`) にも同じ関数から作られるため。 site を配っていない
 * stack に `SiteDeploymentLogs` という名前の log group が現れると、 読んだ人が実態を誤解する。
 */
function spaDeploymentLogGroup(scope: Construct): LogGroup {
  const existing = scope.node.tryFindChild("BucketDeploymentLogs");
  return (existing as LogGroup | undefined) ?? deploymentLogGroup(scope, "BucketDeploymentLogs");
}

/**
 * Issue #867: `runtime-config.json` を **絶対にキャッシュさせず** (no-store / no-cache /
 * must-revalidate)、 deploy 毎に CloudFront invalidation する。 古い設定が残ると
 * テナント設定の混線 / participant 全員の画面故障につながるため、 この cache 方針は
 * 3 配信面 (admin-console / application-admin-console / participant-portal) 共通の不変条件。
 * 子 ID は従来と同じ `RuntimeConfigDeployment` を維持する (logical ID 不変)。
 */
export function deployRuntimeConfigJson(
  scope: Construct,
  target: SpaHostingResult,
  data: Record<string, unknown>,
): void {
  new BucketDeployment(scope, "RuntimeConfigDeployment", {
    logGroup: spaDeploymentLogGroup(scope),
    sources: [Source.jsonData("runtime-config.json", data)],
    destinationBucket: target.siteBucket,
    distribution: target.distribution,
    distributionPaths: ["/runtime-config.json"],
    prune: false,
    cacheControl: [CacheControl.noStore(), CacheControl.noCache(), CacheControl.mustRevalidate()],
  });
}
