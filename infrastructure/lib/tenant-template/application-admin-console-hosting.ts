import * as path from "node:path";
import { Stack } from "aws-cdk-lib";
import type { Distribution } from "aws-cdk-lib/aws-cloudfront";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { buildSpaHosting, deployRuntimeConfigJson } from "../hosting/spa-hosting.js";
import type { CustomDomainConfig } from "../security/cloudfront-custom-domain.js";
import { buildSecurityHeadersPolicy } from "../security/cloudfront-headers.js";

interface ApplicationAdminConsoleHostingProps {
  /** TenantTemplateStack を識別するためのテナント ID。pooled の場合は "pooled" */
  readonly tenantId: string;
  /**
   * Issue #1695: opt-in のカスタムドメイン + ACM 証明書。 設定時のみ TLS 1.2 を強制する。
   * 未設定なら default 証明書配信のまま (NO-OP)。
   */
  readonly customDomain?: CustomDomainConfig;
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
   * (= "TemplateURL must be a supported URL")。 #1053 以降は `ProblemDeployBackendStack` の
   * `CompetitorBootstrapHosting` が deploy 時に同 yaml を upload した URL を、 呼び出し元が
   * クロススタック参照で注入する。
   * optional なのは problem-deploy を配線しない構成 (= 本 construct を直接 instantiate する
   * unit test) のためで、 install.sh / Lite の deploy では常に値が入る。
   * 未設定なら frontend は GitHub raw URL に fallback する (= dev 用)。
   */
  readonly competitorBootstrapTemplateUrl?: string;
  /**
   * Issue #897: テナント isolation mode (= "pooled" | "silo")。
   * "pooled" は UserPool を全 pooled tenant が共有しているため、 SAML SSO のように
   * UserPool を mutate する機能は他 tenant に副作用を及ぼす。 frontend はこの値を見て
   * SAML SSO page を非表示にし、 \"upgrade to PLATINUM\" promo を出す。
   * "silo" は PLATINUM tier の独立 UserPool。 SAML SSO 設定が安全に有効化できる。
   */
  readonly isolation: "pooled" | "silo";
  /**
   * Issue #1340 Phase 2: SAML HRD directory (= email ドメイン → 接続済み SAML provider 名)。
   * application-admin-console の Login 画面が email から候補 IdP を解決して
   * `identity_provider=` を組み立てる public metadata。 SAML 未設定なら空 object `{}`
   * (= 全 email が Cognito local auth に流れる、 既存動作互換)。 未認証 Login が読む値なので
   * 非秘匿で runtime-config.json に書き込んで OK。
   */
  readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;
  /**
   * Issue #2230 (ADR-035): SPA feature flag の deploy 時 override。 SPA 側
   * `resolveFeatureFlags(FEATURE_REGISTRY, runtimeConfig.features)` が registry default に
   * merge する (未知 key / 非 boolean は SPA 側で無視)。 未設定なら `features` key 自体を
   * 書かない (= 旧 runtime-config と byte 互換、 registry default のまま)。
   */
  readonly features?: Readonly<Record<string, boolean>>;
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

  constructor(scope: Construct, id: string, props: ApplicationAdminConsoleHostingProps) {
    super(scope, id);

    // Issue #855 + #896: CloudFront に security headers を強制。 application-admin-console は
    // tenant 別の API GW + Cognito UserPool 経路に connect するが、 具体 URL は per-tenant で
    // 動的に決まる (= runtime-config.json 経由)。 CSP host-source の wildcard は **leftmost のみ**
    // 仕様 (CSP3) で許可される。 旧 `*.execute-api.*.amazonaws.com` は中段 `*` を含み spec 違反、
    // ブラウザは silently ignore → 全 fetch が \"Refused to connect by CSP\" で fail していた。
    // 単一 wildcard に倒すため region は synth 時に Stack.region から inject する。
    const region = Stack.of(this).region;
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        "https://*.amazoncognito.com",
        `https://*.execute-api.${region}.amazonaws.com`,
        `https://*.lambda-url.${region}.on.aws`,
      ],
      formActionAllowedOrigins: ["https://*.amazoncognito.com"],
    });

    // dist/ は infrastructure/lib/tenant-template/ から 3 階層上にある
    // apps/application-admin-console/dist を参照する。
    // host 実行時 (phase 1 pooled stack) は TenkaCloud/apps/application-admin-console/dist、
    // CodeBuild 実行時 (silo stack) は STAGING/apps/application-admin-console/dist。
    // どちらも install.sh が事前に build + 配置する。
    const distDir = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps",
      "application-admin-console",
      "dist",
    );

    // 共通スキャフォールド (S3 + OAI + CloudFront + SPA fallback + dist deployment) は
    // buildSpaHosting (Issue #2207) に集約。 本 Construct は CSP と runtime-config だけを持つ。
    const hosting = buildSpaHosting(this, {
      distDir,
      securityHeaders,
      customDomain: props.customDomain,
    });
    this.bucket = hosting.siteBucket;
    this.distribution = hosting.distribution;

    this.distributionDomainName = this.distribution.distributionDomainName;
    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;
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
    const data: Record<string, unknown> = {
      cognitoDomain: props.cognitoDomain,
      userClientId: props.cognitoClientId,
      tenantId: props.tenantId,
      tenantName: props.tenantName,
      apiUrl: props.apiUrl.replace(/\/$/, ""),
      isolation: props.isolation,
      // Issue #1340 Phase 2: SAML 未設定なら空 object `{}` で焼く (= frontend は loadConfig 側で
      // 空 fallback 済、 値の有無で動作分岐させる必要は無いが空でも 「key 自体は存在する」 が
      // 望ましい (= future-proof の defensive defaults))。
      samlIdpDirectory: props.samlIdpDirectory,
      ...(props.participantPortalUrl ? { participantPortalUrl: props.participantPortalUrl } : {}),
      ...(props.competitorBootstrapTemplateUrl
        ? { competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl }
        : {}),
      // Issue #2230 (ADR-035): 旧来 S3 手編集しか経路が無かった feature flag override の正規経路。
      ...(props.features ? { features: props.features } : {}),
    };
    // Issue #867: runtime-config.json は CloudFront cache 無効化。 pooled tenants 共有 CDN
    // でも tenant 別 config を返すため cache はリスク (= 設定混線)。
    deployRuntimeConfigJson(
      this,
      { siteBucket: this.bucket, distribution: this.distribution },
      data,
    );
  }
}
