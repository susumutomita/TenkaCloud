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

interface ApplicationAdminConsoleHostingProps {
  /** TenantTemplateStack を識別するためのテナント ID。pooled の場合は "pooled" */
  readonly tenantId: string;
}

interface RuntimeConfigProps {
  /**
   * Cognito Hosted UI の base URL。
   * 例: `https://TenkaCloud-app-tenant1.auth.ap-northeast-1.amazoncognito.com`
   * IdentityProvider.cognitoDomainUrl から渡す。
   */
  readonly cognitoDomain: string;
  /** UserPoolClient の ID。IdentityProvider.tenantUserPoolClient.userPoolClientId */
  readonly cognitoClientId: string;
  /**
   * テナント ID (ULID 等)。システム内部で使う識別子。app 側で API 呼び出し等に
   * 利用する想定で、画面には直接表示しない。
   */
  readonly tenantId: string;
  /**
   * 画面表示用のテナント名。admin-console での tenant 作成時に入力された名前。
   * pooled stack の場合は "Shared Pooled Tenant" 等の default。
   */
  readonly tenantName: string;
  /**
   * application-admin-console が叩くテナント API の base URL。
   * Issue #458 / ADR-001 後: Deploy 系 endpoint も同じ tenant API に統合されているので、
   * frontend は本 URL 1 本で全 API 呼び出しを賄う。
   * ApiGateway.restApi.url (末尾スラッシュ有) から渡す。
   */
  readonly apiUrl: string;
  /**
   * Participant Portal の CloudFront URL。EventDetail / DeploymentDetail で operator が
   * 「このイベントの portal を共有」できるようにするため runtime-config.json に注入する。
   * 未設定 (Participant Portal 無効化時) なら undefined → frontend は fallback 表示。
   */
  readonly participantPortalUrl?: string;
  /**
   * #718: 競技者向け CFn bootstrap template (competitor-bootstrap.yaml) の public S3 URL。
   * CFn `TemplateURL` は S3 / SSM の URL しか受け付けず、 GitHub raw URL は reject される
   * (= "TemplateURL must be a supported URL")。 AdminConsoleHostingStack の
   * CompetitorBootstrapTemplateBucket が deploy 時に同 yaml を upload した URL を注入する。
   * Phase 1 deploy 時点では Phase 2 stack が未存在のため optional (undefined) で、
   * Phase 3 で install.sh が tenant-template-pooled を再 deploy するときに値が埋まる。
   * 未設定なら frontend は GitHub raw URL に fallback する (= dev / 初回 deploy 用)。
   */
  readonly competitorBootstrapTemplateUrl?: string;
}

/**
 * テナント開発者向け管理 UI (application-admin-console) を S3 + CloudFront で
 * 配信する Construct。TenantTemplateStack に組み込まれる。
 *
 * silo / pooled 両モードで同じ Construct を使う。
 *   - pooled: install.sh phase 1 で 1 度だけ立つ共有 console。tenantId="pooled"。
 *   - silo:   provision-tenant.sh が PLATINUM tier で per-tenant に都度立てる。
 *
 * dist/ の供給は install.sh が担当する。
 *   - host 実行 (pooled stack deploy 時) は TenkaCloud/apps/application-admin-console/dist
 *   - CodeBuild 実行 (silo stack deploy 時) は STAGING/apps/application-admin-console/dist
 *     (どちらも install.sh が apps/application-admin-console を bun build した上で配置する)
 *
 * runtime-config.json (Cognito 設定) は IdentityProvider が確定してから
 * deployRuntimeConfig() で配置する。コンストラクタで一度に作らないのは、
 * IdentityProvider が UserPoolClient の callback URL に本 Construct の
 * distributionUrl を必要とするため (循環参照を 2 段階構築で回避)。
 *
 * tenantId 注入は本 Construct には含まれない (#48 で追加)。
 */
export class ApplicationAdminConsoleHosting extends Construct {
  public readonly distributionDomainName: string;
  public readonly distributionUrl: string;
  private readonly bucket: Bucket;
  private readonly distribution: Distribution;

  constructor(scope: Construct, id: string, _props: ApplicationAdminConsoleHostingProps) {
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

    // Issue #855: CloudFront に security headers を強制。 application-admin-console は tenant
    // 別の API GW + Cognito UserPool 経路に connect するが、 具体 URL は per-tenant で動的に決まる
    // (= runtime-config.json 経由)。 CSP connect-src / form-action は AWS の domain wildcard で
    // 許容する (= 厳格化は別 issue、 全 tenant で共通のため individual URL の追加配線は別途検討)。
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        "https://*.amazoncognito.com",
        "https://*.execute-api.*.amazonaws.com",
      ],
      formActionAllowedOrigins: ["https://*.amazoncognito.com"],
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

    // dist/ は infrastructure/lib/tenant-template/ から 3 階層上にある
    // apps/application-admin-console/dist を参照する。
    // host 実行時 (phase 1 pooled stack) は TenkaCloud/apps/application-admin-console/dist、
    // CodeBuild 実行時 (silo stack) は STAGING/apps/application-admin-console/dist。
    // どちらも install.sh が事前に build + 配置する。
    const distDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "apps",
      "application-admin-console",
      "dist",
    );

    new BucketDeployment(this, "SiteDeployment", {
      sources: [Source.asset(distDir)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      // runtime-config.json を別途配置するので prune=false (他 key を消さない)
      prune: false,
    });
  }

  /**
   * IdentityProvider + ApiGateway 確定後に呼び出して、application-admin-console が
   * 起動時に fetch する `/runtime-config.json` を CloudFront に配置する。
   *
   * 中身は `{ cognitoDomain, userClientId, tenantId, tenantName, apiUrl, participantPortalUrl? }`。
   *   - cognitoDomain / userClientId: 認証で使う
   *   - tenantId: 内部 (API 呼び出し等)
   *   - tenantName: 画面表示用 (HomePage 等)
   *   - apiUrl: アプリ管理 API の base URL (POST /apps 等、#40-d)
   *   - participantPortalUrl: 競技者向け Portal の CloudFront URL (sparse、未設定なら field 自体を出さない)
   */
  deployRuntimeConfig(props: RuntimeConfigProps): void {
    const data: Record<string, string> = {
      cognitoDomain: props.cognitoDomain,
      userClientId: props.cognitoClientId,
      tenantId: props.tenantId,
      tenantName: props.tenantName,
      apiUrl: props.apiUrl.replace(/\/$/, ""),
      ...(props.participantPortalUrl ? { participantPortalUrl: props.participantPortalUrl } : {}),
      ...(props.competitorBootstrapTemplateUrl
        ? { competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl }
        : {}),
    };
    new BucketDeployment(this, "RuntimeConfigDeployment", {
      sources: [Source.jsonData("runtime-config.json", data)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/runtime-config.json"],
      prune: false,
    });
  }
}
