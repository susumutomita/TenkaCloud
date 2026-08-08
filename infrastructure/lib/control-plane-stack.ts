import { CognitoAuth, ControlPlane, type ControlPlaneAPI } from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import type {
  CfnUserPool,
  CfnUserPoolClient,
  IUserPool,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { ControlPlaneIdpApi } from "./control-plane/control-plane-idp-api.js";
import { buildInviteEmailBody, INVITE_EMAIL_SUBJECT } from "./control-plane/invite-message.js";
import { applyControlPlaneManagedLogin } from "./control-plane/managed-login.js";
import {
  SYSTEM_ADMIN_ENABLED_MFAS,
  SYSTEM_ADMIN_MFA_CONFIGURATION,
  SYSTEM_ADMIN_PASSWORD_POLICY,
} from "./control-plane/mfa-policy.js";
import { attachFederatedAdminAllowlist } from "./control-plane/saml-admin-allowlist.js";
import {
  attachSamlIdentityProviders,
  type IdpDirectory,
  type SamlIdpConfig,
} from "./control-plane/saml-identity-providers.js";
import { dataTableRemovalPolicy } from "./problem-deploy/data-table-removal-policy.js";
import { SamlIdpsTable } from "./problem-deploy/saml-idps-table.js";
import type { CustomDomainConfig } from "./security/cloudfront-custom-domain.js";
import { attachCognitoCustomLoginDomain } from "./security/cognito-custom-domain.js";

interface ControlPlaneStackProps extends cdk.StackProps {
  systemAdminEmail: string;
  /**
   * Issue #1031: admin-console の CloudFront URL (= `AdminConsoleHostingStack.distributionDomainName`)。
   * 旧 `process.env.CDK_PARAM_ADMIN_CONSOLE_ORIGIN` env 直読みを撤廃し、 prop で受ける形に揃えた。
   * 未指定 (= optional) は test や hosting stack 不在ケースで許容。
   */
  adminConsoleOrigin?: string;
  /**
   * Issue #1993: System Admin ログイン用 Cognito カスタムドメイン (任意)。 未設定なら
   * 従来の cognito-prefix domain のまま (NO-OP)。 cert は us-east-1 必須、 DNS は operator 用意。
   */
  loginCustomDomain?: CustomDomainConfig;
  /**
   * Issue #1335 Phase 1: opt-in で attach する SAML IdP 群。 未指定 / 空配列なら従来通り
   * Cognito local auth のみ (= MFA 強制)。 設定時のみ allowlist + sign-in audit が動く。
   * env から bin/infrastructure → app-config で parse 済の正規化 list を受ける。
   */
  samlIdps?: readonly SamlIdpConfig[];
  /**
   * Issue #1335 Phase 1: federated 管理者 allowlist (`provider/email`)。 `samlIdps` 設定時
   * のみ意味を持つ。 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  samlAdminAllowlist?: readonly string[];
  /**
   * ADR-049 §5.1 / Issue #2290: control-plane data backend (`dynamodb` | `turso`)。
   * `/admin/idp` CRUD Lambda が repository seam をどちらに解決するかを決める。 未指定 (=
   * `dynamodb`) なら Lambda env を足さず、 system scope の `SamlIdpsTable` を synth する。
   * `turso` では table を **synth せず** SQL executor に直結する (= Lite と同条件)。
   */
  controlDataBackend?: string;
  /** [Issue #2959] SamlIdps table を stack 削除後も残すか。未指定は DESTROY。 */
  retainDataTables?: boolean;
  /** Public remote libSQL URL (turso backend のみ)。 */
  tursoDatabaseUrl?: string;
  /** libSQL auth token を持つ SSM SecureString parameter 名 (turso backend のみ)。 */
  tursoAuthTokenParameterName?: string;
}

/**
 * ref の control-plane-stack.ts + TenkaCloud 独自の最小調整:
 * 1. CORS allowOrigins に localhost dev を追加 (ref は https://* のみで HTTP localhost NG)
 * 2. SBT 内蔵 UserPoolUserClient の callbackUrls を override して localhost 多ポート許可
 *    (ref は `http://localhost` プレースホルダ 1 個のみ、apps/admin-console の 5173 等が弾かれる)
 */
const LOCALHOST_CALLBACK_URLS = [
  "http://localhost:5173/callback", // apps/admin-console vite dev
  "http://localhost:4173/callback", // apps/admin-console vite preview
];

const LOCALHOST_LOGOUT_URLS = ["http://localhost:5173/", "http://localhost:4173/"];

const LOCALHOST_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:4180",
];

// SBT 0.3.9 contained the `tenantManagementServicves` typo in its construct path. 0.9.5
// fixes that path, which would otherwise make CDK emit a new logical id and CloudFormation
// replace the stateful TenantDetails table. Pin the historical id until a separately staged
// data migration intentionally replaces the table.
const LEGACY_TENANT_DETAILS_LOGICAL_ID =
  "ControlPlanetenantManagementServicvestenantManagementTableTenantDetails974E95B8";

export class ControlPlaneStack extends cdk.Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventBusArn: string;
  /**
   * SBT 内蔵 Cognito UserPool (= System Admin が登録される pool)。
   * Issue #590 / ADR-011 (Phase 1.A) で AdminInsight HTTP API の JWT Authorizer に渡す。
   * 同 pool の SystemAdmin group claim を required scope として扱う。
   */
  public readonly cognitoUserPool: IUserPool;
  /**
   * SBT 内蔵 UserPoolUserClient の client ID (= admin-console が OAuth Code+PKCE で使う)。
   * AdminInsight HTTP API の JWT Authorizer も同 client を audience とみなす。
   */
  public readonly cognitoUserClientId: string;
  /**
   * Issue #1031: SBT 内蔵 UserPoolDomain の base URL (= `https://<prefix>.auth.<region>.amazoncognito.com`)。
   * `AdminConsoleRuntimeConfigStack` が runtime-config.json に焼き込む値を cross-stack ref で受ける。
   * SBT は cognitoDomain を public field として expose しないため、 内部 child `UserPoolDomain` を
   * findChild で取り出して `.baseUrl()` を呼ぶ。
   */
  public readonly cognitoDomain: string;
  /**
   * Issue #1335 Phase 1: admin-console の Login 画面に渡す HRD directory (domain → providerName[])。
   * SAML 未設定なら空 object。 `AdminConsoleRuntimeConfigStack` が `runtime-config.json` に
   * 焼き込んで配信する (= 未認証の Login 画面が読む public, 非秘匿)。
   */
  public readonly samlIdpDirectory: IdpDirectory;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, "CognitoAuth", {
      setAPIGWScopes: false, // done for testing purposes. Scopes should be used for added security in production!
    });

    // Issue #1031: admin-console の CloudFront URL は cross-stack ref で props 経由。 旧 env 直読みは廃止。
    const adminConsoleOrigin = props.adminConsoleOrigin;
    const extraCorsOrigins = adminConsoleOrigin ? [adminConsoleOrigin] : [];
    const extraCallbackUrls = adminConsoleOrigin ? [`${adminConsoleOrigin}/callback`] : [];
    const extraLogoutUrls = adminConsoleOrigin ? [`${adminConsoleOrigin}/`] : [];

    const controlPlane = new ControlPlane(this, "ControlPlane", {
      auth: cognitoAuth,
      systemAdminEmail: props.systemAdminEmail,
      apiCorsConfig: {
        // ref の 'https://*' (HTTPS 全許可) に加えて localhost dev と CloudFront URL を許可
        allowOrigins: ["https://*", ...LOCALHOST_CORS_ORIGINS, ...extraCorsOrigins],
        allowCredentials: false,
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [cdk.aws_apigatewayv2.CorsHttpMethod.ANY],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    const tenantDetailsTable = controlPlane.node
      .findChild("tenantManagementService")
      .node.findChild("tenantManagementTable")
      .node.findChild("TenantDetails").node.defaultChild as cdk.aws_dynamodb.CfnTable;
    tenantDetailsTable.overrideLogicalId(LEGACY_TENANT_DETAILS_LOGICAL_ID);

    // SBT 内蔵 UserPoolUserClient の callbackUrls を escape hatch で上書きして
    // CloudFront URL を許可する。
    // Issue #861: production では localhost callback URL を含めない (= phishing 経路で
    // localhost dev tool に redirect される攻撃面を縮減)。 dev / staging は維持。
    const isProduction = process.env.CDK_PARAM_ENVIRONMENT === "production";
    const userClient = cognitoAuth.node.findChild("UserPoolUserClient") as UserPoolClient;
    const cfnUserClient = userClient.node.defaultChild as CfnUserPoolClient;
    cfnUserClient.addPropertyOverride(
      "CallbackURLs",
      isProduction
        ? [...extraCallbackUrls]
        : ["http://localhost", ...LOCALHOST_CALLBACK_URLS, ...extraCallbackUrls],
    );
    cfnUserClient.addPropertyOverride(
      "LogoutURLs",
      isProduction
        ? [...extraLogoutUrls]
        : ["http://localhost", ...LOCALHOST_LOGOUT_URLS, ...extraLogoutUrls],
    );

    // Issue #1696 (audit 3 / 12): SystemAdmin セッションの堅牢化。 SBT が内部生成する
    // UserPoolUserClient に token validity を escape hatch で明示する。 access / id token は
    // 60 分、 refresh token は default 30 日が「長すぎる」指摘なので 1 日に短縮 (運用で調整可)。
    // `TokenValidityUnits` を明示しないと AccessTokenValidity=60 は 60 *時間* と解釈されるため
    // 単位も必ず併せて指定する。 `EnableTokenRevocation` を明示 true にして、 frontend logout が
    // 呼ぶ `/oauth2/revoke` (#833) が refresh token を実効的に失効できるよう担保する。
    cfnUserClient.addPropertyOverride("AccessTokenValidity", 60);
    cfnUserClient.addPropertyOverride("IdTokenValidity", 60);
    cfnUserClient.addPropertyOverride("RefreshTokenValidity", 1);
    cfnUserClient.addPropertyOverride("TokenValidityUnits", {
      AccessToken: "minutes",
      IdToken: "minutes",
      RefreshToken: "days",
    });
    cfnUserClient.addPropertyOverride("EnableTokenRevocation", true);

    // Issue #653: SBT default の SystemAdmin 招待メール本文は `http://localhost` を
    // 埋めてしまうため、 admin-console origin に書き換える。 Phase 1 deploy 時は
    // CDK_PARAM_ADMIN_CONSOLE_ORIGIN 未確定なので fallback 文面、 Phase 3 再 deploy で
    // CloudFront URL に解決される。
    const cfnUserPool = cognitoAuth.userPool.node.defaultChild as CfnUserPool;
    cfnUserPool.addPropertyOverride(
      "AdminCreateUserConfig.InviteMessageTemplate.EmailSubject",
      INVITE_EMAIL_SUBJECT,
    );
    cfnUserPool.addPropertyOverride(
      "AdminCreateUserConfig.InviteMessageTemplate.EmailMessage",
      buildInviteEmailBody(adminConsoleOrigin),
    );

    // Issue #1035: SystemAdmin は SaaS 全 tenant 横断の権限を持つので MFA 必須化 + 強 password。
    // SBT 0.3.9 が UserPool を内部生成するため escape hatch で CFn property を上書きする。
    // TenantAdmin 側 (= tenant-template/identity-provider.ts) は ADR-020 Phase E で同 baseline 適用済み。
    // TOTP only (= SMS は SNS コスト + 国際到達率不安定で避ける)。
    cfnUserPool.addPropertyOverride("MfaConfiguration", SYSTEM_ADMIN_MFA_CONFIGURATION);
    cfnUserPool.addPropertyOverride("EnabledMfas", [...SYSTEM_ADMIN_ENABLED_MFAS]);
    cfnUserPool.addPropertyOverride("Policies.PasswordPolicy", {
      ...SYSTEM_ADMIN_PASSWORD_POLICY,
    });

    const eventBus = EventBus.fromEventBusArn(this, "eventBus", controlPlane.eventManager.busArn);

    // for monitoring purposes
    new Rule(this, "EventBusWatcherRule", {
      eventBus: eventBus,
      enabled: true,
      eventPattern: {
        source: [
          controlPlane.eventManager.controlPlaneEventSource,
          controlPlane.eventManager.applicationPlaneEventSource,
        ],
      },
    });

    new LogGroup(this, "EventBusWatcherLogGroup", {
      logGroupName: `/aws/events/EventBusWatcher-${this.node.addr}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_WEEK,
    });

    // Issue #1335 Phase 1: opt-in SAML SSO attach。
    //
    // 1. SAML IdP attach: env 未設定 (samlIdps が空 / undefined) なら何もしない (= 既存
    //    Cognito local auth + MFA 強制のまま)。 設定時のみ UserPool に SAML provider を
    //    attach し、 client の SupportedIdentityProviders を COGNITO + 各 provider に拡張。
    // 2. federated admin allowlist: SAML が有効なときだけ attach。 空配列でも attach する
    //    (= fail-safe、 「誰でも管理者」 構成事故を防ぐ)。
    // 3. sign-in audit Lambda は AdminConsoleInsightStack 側で attach する (= 同 stack に
    //    adminAuditLogTable と Control Plane UserPool が cross-stack ref で揃うため、
    //    Control Plane → Insight 方向の 1 way ref で配線できる)。
    const samlIdps = props.samlIdps ?? [];
    const userPool = cognitoAuth.userPool as UserPool;
    this.samlIdpDirectory = attachSamlIdentityProviders(this, userPool, cfnUserClient, samlIdps);
    if (samlIdps.length > 0) {
      // SAML 有効時のみ Pre sign-up allowlist を attach。 空配列でも attach する (fail-safe)。
      attachFederatedAdminAllowlist(this, userPool, props.samlAdminAllowlist ?? []);
    }

    // Issue #1293 の CDK 配線 (#2941): System Admin 向け SAML IdP CRUD API (`/admin/idp*`)。
    //
    // 上の `attachSamlIdentityProviders` は **synth 時 config** (`CDK_PARAM_SAML_IDPS`) から
    // provider を静的に作る経路で、 runtime に IdP を足す口が無かった。 handler / test は #1293 で
    // 揃っていたが construct から一度も instantiate されておらず、 admin-console の「ID プロバイダ」
    // 画面は `GET /admin/idp` → 未マッチ 404 (CORS header 無し) → `Failed to fetch` になっていた。
    // したがって `samlIdps` の設定有無では gate しない — runtime CRUD は静的 config が空の状態から
    // IdP を登録するための API なので、 静的 config を前提にすると存在意義が消える。
    //
    // route は SBT の ControlPlane API に相乗りさせる。 SBT は `controlPlaneApi` (= ControlPlaneAPI)
    // を public field として expose しないため findChild で取り出す (= 上の tenantDetailsTable と
    // 同じ escape hatch)。 `as ControlPlaneAPI` にしているのは、 SBT 側が construct 名を変えたとき
    // synth 時ではなく tsc で落とすため。
    const controlPlaneApi = controlPlane.node.findChild("controlPlaneApi") as ControlPlaneAPI;
    // [Issue #2442 / Phase C5 と同条件] 純 SQL backend では table を synth しない (= standing cost 0)。
    // API 自体は backend に関わらず常に提供する。
    const pureSql = props.controlDataBackend === "turso";
    const samlIdpsTable = pureSql
      ? undefined
      : new SamlIdpsTable(this, "SamlIdps", {
          removalPolicy: dataTableRemovalPolicy(props.retainDataTables),
        });
    new ControlPlaneIdpApi(this, "ControlPlaneIdpApi", {
      httpApi: controlPlaneApi.api,
      // SBT の HttpApi は defaultAuthorizer を持たない (corsPreflight のみ) ため明示的に渡す。
      // 渡し忘れると `/admin/idp` が無認証で公開される。
      authorizer: controlPlaneApi.jwtAuthorizer,
      userPool: cognitoAuth.userPool,
      samlIdpsTable: samlIdpsTable?.table,
      controlDataBackend: props.controlDataBackend,
      tursoDatabaseUrl: props.tursoDatabaseUrl,
      tursoAuthTokenParameterName: props.tursoAuthTokenParameterName,
    });

    this.eventBusArn = controlPlane.eventManager.busArn;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
    // SBT CognitoAuth が払い出した UserPool / UserClient を兄弟 stack
    // (AdminConsoleInsightStack) の JWT Authorizer 用に export する。
    this.cognitoUserPool = cognitoAuth.userPool;
    this.cognitoUserClientId = cognitoAuth.userClientId;
    // Issue #1031: SBT 内蔵 UserPoolDomain (= cognito-auth.js:104 で `new UserPoolDomain` される
    // 子 construct) を findChild で取り出して baseUrl を expose。 `AdminConsoleRuntimeConfigStack`
    // が runtime-config.json の `cognitoDomain` field に焼き込む。
    const userPoolDomain = cognitoAuth.node.findChild("UserPoolDomain") as UserPoolDomain;
    this.cognitoDomain = userPoolDomain.baseUrl();

    // Issue #1992 (Phase 2 of #1990): System Admin ログインを classic Hosted UI から
    // Managed login (v2) へ移行する。 Application Plane (#1991) と同方針。 SBT 内蔵の
    // UserPool / UserPoolDomain / client を attach module へ渡して branding を適用する。
    applyControlPlaneManagedLogin(this, {
      userPool: cognitoAuth.userPool,
      userPoolDomain,
      clientId: cognitoAuth.userClientId,
    });

    // Issue #1993: System Admin ログインの Cognito カスタムドメイン (param-gated)。 未設定なら
    // NO-OP (= cognito-prefix domain のまま)。 設定時は managed login v2 の custom domain を足す。
    attachCognitoCustomLoginDomain(this, "ControlPlaneLoginCustomDomain", {
      userPoolId: cognitoAuth.userPool.userPoolId,
      config: props.loginCustomDomain,
    });
  }
}
