import { createHash } from "node:crypto";
import { aws_cognito, Duration, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { IdentityDetails } from "../interfaces/identity-details.js";
import type { CustomDomainConfig } from "../security/cloudfront-custom-domain.js";
import { attachCognitoCustomLoginDomain } from "../security/cognito-custom-domain.js";
import {
  buildInkManagedLoginAssets,
  buildInkManagedLoginSettings,
} from "../shared/managed-login-branding.js";

// Cognito InviteMessageTemplate の placeholder。{username} は admin-create-user 時に
// 指定したユーザー名、{####} は Cognito 自動生成の一時パスワードに置換される。
// admin-create-user 経路と CustomMessage Lambda trigger の双方で共通仕様。
const COGNITO_USERNAME = "{username}";
const COGNITO_TEMP_PASSWORD = "{####}";

/**
 * Issue #903: 招待メール文面を英語のみに統一する (= 旧 4 言語混在は Gmail で改行が collapse
 * して読めなくなる問題があった)。 Control Plane の System Admin 招待 (Issue #714) と同じ方針。
 *
 * 改行は **`<br>`** を使う。 Cognito は `InviteMessageTemplate` を **HTML メール**として配信する
 * ため、 `\n` / `\n\n` は Gmail / Outlook で空白に collapse され、 全文が 1 行に潰れて読めなく
 * なる (実機で確認)。 段落間は `<br><br>` (= 配列の空要素)、 連続する credential 行は単一 `<br>`。
 *
 * Cognito `InviteMessageTemplate` は **UserPool あたり 1 言語**しか保持できないので、
 * 多言語化が必要なら `custom:locale` 属性 + CustomMessage Lambda Trigger + SES への移行が
 * 必要 (= 別 issue)。 当面は SaaS の lingua franca = 英語のみ。
 */
function buildInviteEmailBody(consoleUrl: string): string {
  return [
    "Welcome to TenkaCloud Battle / Challenge.",
    "A temporary account has been issued so you can sign in to the Tenant Admin Console.",
    "",
    `Username: ${COGNITO_USERNAME}`,
    `Temporary password: ${COGNITO_TEMP_PASSWORD}`,
    `Sign-in URL: ${consoleUrl}`,
    "",
    "Set a new password on first sign-in. From the Tenant Admin Console you can create competition Events and hand out Participant Portal URLs.",
    "",
    "If this email looks unfamiliar, please discard it.",
    "",
    "-- TenkaCloud Operations",
  ].join("<br>");
}

interface IdentityProviderProps {
  /** テナント ID。pooled の場合は "pooled" */
  readonly tenantId: string;
  /**
   * 環境名 (development / staging / production など)。Cognito UserPool domain prefix
   * の region globally unique 制約を満たすため tenantId / accountId と組み合わせて使う。
   */
  readonly environment: string;
  /**
   * application-admin-console の CloudFront URL (例: `https://d123abc.cloudfront.net`)。
   * Cognito UserPoolClient の callbackUrls / logoutUrls に登録する。
   * 末尾スラッシュは付けないこと。
   */
  readonly applicationAdminConsoleUrl: string;
  /**
   * Issue #1993 / #1994: tenant ログイン用 Cognito カスタムドメイン (任意)。 未設定なら従来の
   * cognito-prefix domain のまま (NO-OP)。 pooled なら共有ドメイン、 silo (#1994) なら per-tenant
   * deploy が各自のサブドメインを渡す。 cert は us-east-1 必須、 DNS は operator 用意。
   */
  readonly loginCustomDomain?: CustomDomainConfig;
  // Issue #1066: SAML IdP 設定は廃止 (= MFA 必須化 #1035 で代替)。
}

/**
 * Issue #861: production では localhost callback URL を含めない (= phishing 経路で localhost
 * dev tool に redirect される攻撃面を縮減)。 development / staging では dev 経路を維持。
 *
 * pure function、 input が同じなら output 不変。 test も容易。
 */
export function buildAllowedRedirectUrls(
  primaryUrl: string,
  environment: string,
  devUrl: string,
): readonly string[] {
  const env = environment.toLowerCase();
  if (env === "production") return [primaryUrl];
  return [primaryUrl, devUrl];
}

/** Cognito が `CreateUserPoolDomain` の `domain` に課す固定上限 (実測で確認)。 */
const COGNITO_DOMAIN_PREFIX_MAX_LENGTH = 63;

/**
 * tenantId が長すぎて上限を超えるときだけ、 衝突しない短い代替へ畳む。
 *
 * 目的は **pooled の既存 domain を絶対に動かさないこと**。 `buildCognitoDomainPrefix` は
 * pooled と silo で共有されており、 書式を無条件に変えると
 * `tenkacloud-development-pooled-672726205532` (42 字、 稼働中) が別名になり
 * `AWS::Cognito::UserPoolDomain` が **REPLACE** されて、 pooled tenant の Hosted UI ログイン
 * URL が変わってしまう。 だから「収まるならそのまま」を厳守する。
 *
 * 畳むときは tenantId を sha256 の先頭 12 字へ落とす。 tenantId は UUID/ULID で衝突しないので、
 * その hash も実用上衝突しない (12 hex = 48bit)。 同じ tenantId なら常に同じ prefix になる
 * (= 再 deploy で REPLACE されない) ことが要件で、 純関数にしてあるのはそのため。
 */
export function buildCognitoDomainPrefix(
  environment: string,
  tenantId: string,
  accountId: string,
): string {
  const env = environment.toLowerCase() || "synth";
  const tid = tenantId.toLowerCase();
  const acct = accountId || "synthplaceholder";
  // Cognito domain prefix は lowercase + 数字 + ハイフンのみ許容。
  const preferred = `tenkacloud-${env}-${tid}-${acct}`;
  if (preferred.length <= COGNITO_DOMAIN_PREFIX_MAX_LENGTH) return preferred;

  // SBT は tenantId に UUID (36 字) を発行する。 `tenkacloud-`(11) + `development`(11) +
  // `-`(1) + 36 + `-`(1) + accountId(12) = 72 字 > 63 で、 silo tenant は Cognito に
  // 弾かれていた ("Member must have length less than or equal to 63")。 pooled は
  // tenantId="pooled" (6 字) で 42 字に収まるため、 この経路には入らない。
  const shortTid = createHash("sha256").update(tid).digest("hex").slice(0, 12);
  return `tenkacloud-${env}-${shortTid}-${acct}`;
}

/**
 * テナント専用の Cognito UserPool / UserPoolClient / UserPoolDomain を作る Construct。
 *
 * - UserPool: silo (per-tenant) の認証受け皿
 * - UserPoolDomain: Cognito Hosted UI のためのドメイン (`TenkaCloud-app-${tenantId}` prefix)
 * - UserPoolClient: application-admin-console の OAuth Code + PKCE flow を受ける。
 *   callbackUrls には CloudFront URL の `/callback` と localhost:5174/callback (dev) を登録する
 */
export class IdentityProvider extends Construct {
  public readonly tenantUserPool: aws_cognito.UserPool;
  public readonly tenantUserPoolClient: aws_cognito.UserPoolClient;
  public readonly tenantUserPoolDomain: aws_cognito.UserPoolDomain;
  /**
   * Cognito Hosted UI の base URL。
   * 例: `https://TenkaCloud-app-tenant1.auth.ap-northeast-1.amazoncognito.com`
   */
  public readonly cognitoDomainUrl: string;
  public readonly identityDetails: IdentityDetails;
  /**
   * Issue #1340 Phase 2: SAML IdP attach 用に CfnUserPoolClient (L1) を expose する。
   * `attachTenantSamlIdentityProviders` が SupportedIdentityProviders に追加するため
   * (= L2 `UserPoolClient` は addPropertyOverride を持たない)。 L2 から `node.defaultChild`
   * で取り出した escape hatch。 SAML 未設定なら本 ref は使われない (= NO-OP)。
   */
  public readonly cfnTenantUserPoolClient: aws_cognito.CfnUserPoolClient;

  constructor(scope: Construct, id: string, props: IdentityProviderProps) {
    super(scope, id);

    // Issue #903: tenant admin 招待は英語のみ (Control Plane #714 と同方針)。 旧 4 言語混在
    // は Gmail で改行が collapse して読めない問題があった。 多言語化が必要なら CustomMessage
    // Lambda Trigger + SES への移行 (= 別 issue) で対応する。
    this.tenantUserPool = new aws_cognito.UserPool(this, "tenantUserPool", {
      // V2 pre-token-generation トリガ (= lite-admin-claims、 Issue #1327 / #1358) が id/access token に
      // `custom:userRole=TenantAdmin` 等を注入するには UserPool が **Essentials 以上** の feature plan で
      // なければならない。 Lite plan では V2 の token customization が無視され claim が乗らず、 tenant API の
      // requireRole が 403 "not a TenantAdmin" を返す (= 監査ログ / IdP 画面の失敗の根因)。 admin のみが
      // Cognito を使い MAU は極小なので Essentials 無料枠 (10k MAU) 内に収まる (cost-zero 原則を維持)。
      featurePlan: aws_cognito.FeaturePlan.ESSENTIALS,
      autoVerify: { email: true },
      accountRecovery: aws_cognito.AccountRecovery.EMAIL_ONLY,
      // ADR-020 Phase E / audit MFA: tenant admin consoles は destructive 操作を扱う
      // (= user 管理 / SAML / 削除 / IAM mutate)。 OPTIONAL では参加率に依存して未設定の admin が
      // 攻撃面に残るため、 REQUIRED で全 admin に TOTP 設定を強制する。
      //
      // signInAliases に email を使う運用なので SMS は使わず TOTP のみ (= 国際 SMS の到達率不安定
      // 問題 + コスト)。 SMS をオフにしたい場合は \`mfaSecondFactor.sms: false\`、 TOTP 必須なので
      // \`otp: true\`。
      //
      // 既存 user 向けの grace period 対策:
      //   - Cognito の REQUIRED mode は first sign-in 時に MFA 登録を促す flow (= ChallengeName=MFA_SETUP)。
      //   - 既存 user は 次回 sign-in 時に MFA 設定 step を 通る必要があるが、 forced reset ではなく
      //     associate-software-token → verify の自然な流れ。
      //   - 既存 TenantAdmin が lock-out された場合の救済は SystemAdmin (= control plane 側) が
      //     AdminResetUserPassword + 再招待で復旧可能。
      mfa: aws_cognito.Mfa.REQUIRED,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      userInvitation: {
        emailSubject: "[TenkaCloud] Tenant Admin Invitation",
        emailBody: buildInviteEmailBody(props.applicationAdminConsoleUrl),
        // Cognito CFn は `InviteMessageTemplate` 設定時に SMSMessage も整合性チェックする
        // (aws-cdk#30315 系の挙動)。SMS は使わないが空にできないため最短形を入れる。
        smsMessage: `TenkaCloud: ${COGNITO_USERNAME} / ${COGNITO_TEMP_PASSWORD}`,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        tenantId: new aws_cognito.StringAttribute({
          mutable: true,
        }),
        userRole: new aws_cognito.StringAttribute({
          mutable: true,
        }),
        apiKey: new aws_cognito.StringAttribute({
          mutable: true,
        }),
        // adding this new custom attribute so that we can determine which API Key
        // to use without having to hit an external db in the lambda tenant_authorizer function
        tenantTier: new aws_cognito.StringAttribute({
          mutable: true,
        }),
        // Issue #748: tenant 作成 form の tenantName を id_token claim に乗せて
        // application-admin-console の Home 画面 (= 「ようこそ {tenantName} さん」 / 「テナント名」)
        // で表示する。 admin (= provision-tenant.sh の admin-create-user) のみ書き込み可、
        // tenant user 自身は writeAttributes から外して cross-tenant 改名を防ぐ。
        tenantName: new aws_cognito.StringAttribute({
          mutable: true,
        }),
      },
    });

    const stack = Stack.of(this);
    const domainPrefix = buildCognitoDomainPrefix(props.environment, props.tenantId, stack.account);
    this.tenantUserPoolDomain = this.tenantUserPool.addDomain("tenantUserPoolDomain", {
      cognitoDomain: { domainPrefix },
      // Issue #1991: テナントログインを classic Hosted UI から Managed login (v2) へ移行する。
      // classic は *-customizable allowlist の制約 (固定クラス名 + 固定プロパティのみ) で
      // design import「Cognito Hosted UI.html」を再現できず、 deploy 後に画面が崩れた
      // (#1987 / #1989 で実証)。 Managed login はブランディングデザイナー世代の UI で、
      // rounded corner / gradient / custom font / ロゴ画像をコード指定できる。
      managedLoginVersion: aws_cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    this.cognitoDomainUrl = `https://${domainPrefix}.auth.${stack.region}.amazoncognito.com`;

    // `custom:tenantId` / `userRole` / `apiKey` / `tenantTier` / `tenantName` は admin
    // (provision-tenant.sh が `admin-create-user` で初期化、必要なら
    // `admin-update-user-attributes` で更新) のみ書き換える。Client の `writeAttributes`
    // から外すことで、ユーザの access_token から `UpdateUserAttributes` で
    // `custom:tenantId` 等を別テナントに書き換えてクロステナント操作する経路を塞ぐ
    // (Deploy API の JWT authorizer が claim を信頼するため)。
    const writeAttributes = new aws_cognito.ClientAttributes().withStandardAttributes({
      email: true,
    });

    // Issue #686 (root cause): id_token に `custom:tenantId` が乗らず deploy 経路で
    // tenant 識別ができなかった。 Cognito の readAttributes が unset だと default で全
    // 標準 attribute が読めるが、 **custom: は明示的に追加しないと id_token claim に
    // 出ない**。 readAttributes に `custom:tenantId` 等を明示する。
    // Issue #748: 同じ理由で `custom:tenantName` も明示しないと application-admin-console
    // の Home 画面 (= JWT 経由の displayName) が ULID にフォールバックする。
    const readAttributes = new aws_cognito.ClientAttributes()
      .withStandardAttributes({
        email: true,
        emailVerified: true,
      })
      .withCustomAttributes("tenantId", "userRole", "apiKey", "tenantTier", "tenantName");

    // Issue #1066: SAML IdP 機能は廃止 (= MFA 必須化 #1035 で代替)。 UserPool は Cognito 単独。
    const authFlows: aws_cognito.AuthFlow = {
      userPassword: true,
      adminUserPassword: false,
      userSrp: true,
      custom: false,
    };

    this.tenantUserPoolClient = new aws_cognito.UserPoolClient(this, "tenantUserPoolClient", {
      userPool: this.tenantUserPool,
      generateSecret: false,
      // Issue #1696 (audit 3 / 12): セッション堅牢化。 access / id token は 60 分 (= 短命、
      // logout 後の残存窓を狭める)。 refresh token は default 30 日が「長すぎる」指摘なので 1 日に
      // 短縮する (運用ポリシーで調整可)。 enableTokenRevocation を明示 true にして、 frontend の
      // beginLogout が呼ぶ `/oauth2/revoke` (#833) が実効的に refresh token を失効させられるよう
      // 担保する (= CDK default も true だが、 監査要件として明示する)。
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(1),
      enableTokenRevocation: true,
      authFlows,
      writeAttributes: writeAttributes,
      readAttributes: readAttributes,
      supportedIdentityProviders: [aws_cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        scopes: [
          aws_cognito.OAuthScope.EMAIL,
          aws_cognito.OAuthScope.OPENID,
          aws_cognito.OAuthScope.PROFILE,
        ],
        flows: {
          authorizationCodeGrant: true,
          // Issue #861: Implicit Grant は OAuth 2.0 で legacy 認定 (RFC 8252 / OAuth 2.1 で廃止)。
          // token を URL fragment で渡し browser history / referrer / log に残るため漏れリスクあり。
          // PKCE + Authorization Code Grant のみで OK なので無効化する。
          implicitCodeGrant: false,
        },
        // Issue #861: localhost callback URL は production では Allowed list に含めない。
        // attacker が phishing 経路で localhost (= dev tooling) への redirect を試みるリスクを
        // 下げる。 dev / staging では引き続き許容して \`make dev\` で application-admin-console を
        // localhost:5174 で立てたデバッグ経路を壊さない。
        callbackUrls: [
          ...buildAllowedRedirectUrls(
            `${props.applicationAdminConsoleUrl}/callback`,
            props.environment,
            "http://localhost:5174/callback",
          ),
        ],
        // frontend beginLogout は `logout_uri=<origin>/login` で /logout に redirect する
        // (application-admin-console/src/auth/cognito.ts)。 Cognito は logout_uri が
        // UserPoolClient の logoutUrls に登録されていないと `Required String parameter
        // 'redirect_uri' is not present` で fail するので、 \`/login\` も含めて allow する。
        // \`/\` は legacy 経路 (= 旧 frontend が `<origin>/` に飛ばしていた時の互換) として残す。
        logoutUrls: [
          ...buildAllowedRedirectUrls(
            `${props.applicationAdminConsoleUrl}/`,
            props.environment,
            "http://localhost:5174/",
          ),
          ...buildAllowedRedirectUrls(
            `${props.applicationAdminConsoleUrl}/login`,
            props.environment,
            "http://localhost:5174/login",
          ),
        ],
      },
    });
    // Issue #1340 Phase 2: SAML IdP の SupportedIdentityProviders 上書きで L1 escape hatch を使う。
    // L2 `UserPoolClient.node.defaultChild` は L1 `CfnUserPoolClient` を返す (CDK 仕様)。
    this.cfnTenantUserPoolClient = this.tenantUserPoolClient.node
      .defaultChild as aws_cognito.CfnUserPoolClient;

    // Issue #1991: テナントログインを Managed login (v2) でブランディングする。 classic の
    // CfnUserPoolUICustomizationAttachment + cognito-hosted-ui.css (#1987 / #1989) を置換する。
    // Managed login branding は userPoolId + clientId に紐づく。
    //
    // ブランディングは ink テーマ + Summit ロゴ。 厳密な settings は巨大 JSON Document だが、
    // Cognito は **指定しなかったトークンを既定値のまま保持する** (= partial settings は valid)
    // ため、 ink ブランドトークンだけを上書きする最小 settings を `shared/managed-login-branding.ts`
    // から取得して投入する (Control Plane #1992 と共有)。 `settings`/`assets` を渡す場合
    // `useCognitoProvidedValues` は **排他** なので省略する。 pixel 一致は Cognito console の
    // branding editor で微調整する前提。
    //
    // managed login の表示には domain (managedLoginVersion=2) が先に存在している必要があるため
    // 明示的に依存を張る (branding は userPoolId / clientId しか参照せず CFn が順序を推論できない)。
    const managedLoginBranding = new aws_cognito.CfnManagedLoginBranding(
      this,
      "tenantManagedLoginBranding",
      {
        userPoolId: this.tenantUserPool.userPoolId,
        clientId: this.tenantUserPoolClient.userPoolClientId,
        settings: buildInkManagedLoginSettings(),
        assets: buildInkManagedLoginAssets(),
      },
    );
    managedLoginBranding.node.addDependency(this.tenantUserPoolDomain);

    // Issue #1993 / #1994: tenant ログインの Cognito カスタムドメイン (param-gated)。 未設定なら
    // NO-OP。 設定時は managed login v2 の custom domain を足す (pooled = #1993、 silo = #1994)。
    attachCognitoCustomLoginDomain(this, "tenantLoginCustomDomain", {
      userPoolId: this.tenantUserPool.userPoolId,
      config: props.loginCustomDomain,
    });

    this.identityDetails = {
      name: "Cognito",
      details: {
        userPoolId: this.tenantUserPool.userPoolId,
        appClientId: this.tenantUserPoolClient.userPoolClientId,
      },
    };
  }
}
