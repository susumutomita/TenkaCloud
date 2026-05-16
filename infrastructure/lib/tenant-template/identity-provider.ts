import { aws_cognito, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { SamlIdpConfig } from "../config/config-interface";
import type { IdentityDetails } from "../interfaces/identity-details";

// Cognito InviteMessageTemplate の placeholder。{username} は admin-create-user 時に
// 指定したユーザー名、{####} は Cognito 自動生成の一時パスワードに置換される。
// admin-create-user 経路と CustomMessage Lambda trigger の双方で共通仕様。
const COGNITO_USERNAME = "{username}";
const COGNITO_TEMP_PASSWORD = "{####}";

/**
 * #529 i18n + #660: 1 通の招待メールに 4 言語 (JA / EN / ES / ZH) を順に並べる + Gmail 等で
 * 単一改行が space に re-flow される問題を回避するため、 各 field を `\n\n` (paragraph
 * break) で区切る。
 *
 * Cognito の `InviteMessageTemplate` は **UserPool あたり 1 言語**しか保持できない (= 4 言語
 * 同梱で送る理由)、 かつ Cognito default 送信は **plain text** で HTML タグが literal text
 * になる (= Option A: HTML 化 は SES verified identity が必要で infra 影響大、 ここでは
 * Option B: plain text 整形強化 を採用)。
 *
 * Phase 2 で `custom:locale` 属性 + CustomMessage Lambda Trigger + SES への移行を予定。
 */
function buildInviteEmailBody(consoleUrl: string): string {
  const divider = "═══════════════════════════════════════════";
  const sections: readonly string[] = [
    // --- 日本語 ---
    [
      "▼ 日本語",
      "",
      "ようこそ TenkaCloud Battle / Challenge へ。",
      "",
      "テナント管理コンソールへサインインするための一時アカウントを発行しました。",
      "",
      `■ ユーザー名: ${COGNITO_USERNAME}`,
      "",
      `■ 一時パスワード: ${COGNITO_TEMP_PASSWORD}`,
      "",
      `■ サインイン URL: ${consoleUrl}`,
      "",
      "初回サインイン時に新しいパスワードを設定してください。 競技イベント (Event) の作成 / 競技者向け Portal URL の払い出しは、 テナント管理コンソールから操作できます。",
    ].join("\n"),

    // --- English ---
    [
      "▼ English",
      "",
      "Welcome to TenkaCloud Battle / Challenge.",
      "",
      "A temporary account has been issued so you can sign in to the Tenant Admin Console.",
      "",
      `■ Username: ${COGNITO_USERNAME}`,
      "",
      `■ Temporary password: ${COGNITO_TEMP_PASSWORD}`,
      "",
      `■ Sign-in URL: ${consoleUrl}`,
      "",
      "Set a new password on first sign-in. From the Tenant Admin Console you can create competition Events and hand out Participant Portal URLs.",
    ].join("\n"),

    // --- Español ---
    [
      "▼ Español",
      "",
      "Bienvenido a TenkaCloud Battle / Challenge.",
      "",
      "Se ha emitido una cuenta temporal para iniciar sesión en la consola de administración de inquilinos.",
      "",
      `■ Usuario: ${COGNITO_USERNAME}`,
      "",
      `■ Contraseña temporal: ${COGNITO_TEMP_PASSWORD}`,
      "",
      `■ URL de inicio de sesión: ${consoleUrl}`,
      "",
      "Establezca una nueva contraseña al iniciar sesión por primera vez. Desde la consola puede crear eventos de competición y emitir URLs del portal para los participantes.",
    ].join("\n"),

    // --- 中文 (简体) ---
    [
      "▼ 中文 (简体)",
      "",
      "欢迎使用 TenkaCloud Battle / Challenge。",
      "",
      "已为您颁发临时账号,用于登录租户管理控制台。",
      "",
      `■ 用户名: ${COGNITO_USERNAME}`,
      "",
      `■ 临时密码: ${COGNITO_TEMP_PASSWORD}`,
      "",
      `■ 登录地址: ${consoleUrl}`,
      "",
      "首次登录时请设置新密码。 在租户管理控制台中,您可以创建比赛活动 (Event) 并发放参赛者门户 URL。",
    ].join("\n"),
  ];

  const footer = [
    "If this email looks unfamiliar, please discard it.",
    "本メールに心当たりがない場合は破棄してください。",
    "Si este correo no le resulta familiar, descártelo.",
    "如果您不认识此邮件,请忽略。",
    "",
    "-- TenkaCloud Operations / 運営 / Operaciones / 运营",
  ].join("\n");

  return [...sections, footer].join(`\n\n${divider}\n\n`);
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
   * Issue #839 follow-up: 全 tenant 共有の SAML IdP 設定 (= operator 会社 SSO)。 未設定なら
   * 従来通り Cognito username/password + Hosted UI fallback。 設定時:
   *  - `UserPoolIdentityProviderSaml` を作る
   *  - UserPoolClient の `supportedIdentityProviders` に追加する
   *  - `enforceSamlOnly: true` なら Cognito provider を `supportedIdentityProviders` から外し
   *    `authFlows.userPassword / userSrp` も無効化する (= SAML 1 経路のみ)
   */
  readonly samlConfig?: SamlIdpConfig;
}

/**
 * Cognito UserPool domain は region 内 global unique なので、複数 AWS account / 複数 env
 * での衝突を避けるために env / tenantId / accountId 全てを prefix に入れる。
 *
 * フォーマット: `TenkaCloud-${env}-${tenantId}-${accountId}`
 *   - env: 11 字 (production) まで想定
 *   - tenantId: pooled (6) または ULID (26)
 *   - accountId: 12 字
 *   - hyphens 含む合計上限 63 字 → ULID + production でも 60 字でぎり収まる
 *
 * env / tenantId / accountId のいずれかが空文字 (synth-only context など) のときは
 * placeholder で synth が通るようにフォールバックする。
 */
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

function buildCognitoDomainPrefix(
  environment: string,
  tenantId: string,
  accountId: string,
): string {
  const env = environment.toLowerCase() || "synth";
  const tid = tenantId.toLowerCase();
  const acct = accountId || "synthplaceholder";
  // Cognito domain prefix は lowercase + 数字 + ハイフンのみ許容。
  return `tenkacloud-${env}-${tid}-${acct}`;
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

  constructor(scope: Construct, id: string, props: IdentityProviderProps) {
    super(scope, id);

    // #529: tenant admin 招待 — 4 言語の multilingual body (JA / EN / ES / ZH) を 1 通に並べる。
    // Cognito は UserPool ごとに 1 template しか持てないため、locale 別配信は CustomMessage
    // Lambda Trigger が要る (Phase 2)。MVP は 4 言語並列で各 operator が読める段落を選ぶ。
    this.tenantUserPool = new aws_cognito.UserPool(this, "tenantUserPool", {
      autoVerify: { email: true },
      accountRecovery: aws_cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        // 多言語 subject (= mail client preview で言語識別できるよう全部入り)
        emailSubject:
          "[TenkaCloud] テナント管理コンソール招待 / Tenant Admin Invitation / Invitación / 租户管理控制台邀请",
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

    // Issue #839 follow-up: SAML IdP を作る (= 設定時)。 UserPoolClient より前に instantiate して
    // `supportedIdentityProviders` から参照する。 CDK は IdP construct の dependency を内部で解決して
    // UserPoolClient より前に CFn 上に置く。
    const samlProvider = props.samlConfig
      ? buildSamlIdentityProvider(this, this.tenantUserPool, props.samlConfig)
      : undefined;

    // `enforceSamlOnly: true` のとき、 UserPoolClient の supportedIdentityProviders から COGNITO
    // を外し、 username/password / SRP authFlow も無効化する (= SAML のみ)。
    const enforceSamlOnly = props.samlConfig?.enforceSamlOnly === true;
    const supportedIdentityProviders = buildSupportedIdentityProviders({
      cognito: !enforceSamlOnly,
      saml: samlProvider,
    });
    const authFlows: aws_cognito.AuthFlow = enforceSamlOnly
      ? { userPassword: false, adminUserPassword: false, userSrp: false, custom: false }
      : { userPassword: true, adminUserPassword: false, userSrp: true, custom: false };

    this.tenantUserPoolClient = new aws_cognito.UserPoolClient(this, "tenantUserPoolClient", {
      userPool: this.tenantUserPool,
      generateSecret: false,
      authFlows,
      writeAttributes: writeAttributes,
      readAttributes: readAttributes,
      supportedIdentityProviders,
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
        logoutUrls: [
          ...buildAllowedRedirectUrls(
            `${props.applicationAdminConsoleUrl}/`,
            props.environment,
            "http://localhost:5174/",
          ),
        ],
      },
    });
    if (samlProvider) {
      // CDK は SupportedIdentityProviders に IdP を渡しても dependency edge を自動生成しないので
      // 明示的に addDependency する (= CFn 上で IdP → UserPoolClient の順で作られることを保証)。
      this.tenantUserPoolClient.node.addDependency(samlProvider);
    }

    this.identityDetails = {
      name: "Cognito",
      details: {
        userPoolId: this.tenantUserPool.userPoolId,
        appClientId: this.tenantUserPoolClient.userPoolClientId,
      },
    };
  }
}

/**
 * Issue #839 follow-up: Cognito UserPool に SAML IdP (= Entra ID / Okta / Google Workspace)
 * を `UserPoolIdentityProviderSaml` (L2) で追加する。 IdP 側の federation metadata XML は
 * URL から fetch する (= rotation 追従)。 attribute mapping は default email のみ自動、 caller が
 * 渡したものが優先。
 */
function buildSamlIdentityProvider(
  scope: Construct,
  userPool: aws_cognito.UserPool,
  config: SamlIdpConfig,
): aws_cognito.UserPoolIdentityProviderSaml {
  const providerName = config.providerName ?? "CompanySAML";
  // SAML AttributeStatement → Cognito attribute の mapping。 email は最低限必要 (= UserPool が
  // email を NameID として扱う設定)、 caller の渡しが無ければ標準 emailaddress namespace に倒す。
  const defaultEmail = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
  const userMapping = config.attributeMapping ?? {};
  const attributeMapping: aws_cognito.AttributeMapping = {
    email: { attributeName: userMapping.email ?? defaultEmail },
  };
  return new aws_cognito.UserPoolIdentityProviderSaml(scope, "TenantSamlIdp", {
    userPool,
    name: providerName,
    metadata: aws_cognito.UserPoolIdentityProviderSamlMetadata.url(config.metadataUrl),
    attributeMapping,
    idpSignout: true,
  });
}

/**
 * UserPoolClient.supportedIdentityProviders を組み立てる pure helper。 SAML / Cognito を独立に
 * 入れ替えられるので test しやすい (= 引数で挙動が決まる)。
 *
 * - SAML only (`{cognito: false, saml: <provider>}`)  → SAML provider のみ
 * - 並列 (`{cognito: true, saml: <provider>}`)        → COGNITO + SAML provider
 * - SAML 無設定 (`{cognito: true, saml: undefined}`)  → COGNITO のみ (= 旧挙動)
 * - 全 false (= 想定外) は COGNITO fallback (= UserPoolClient が validation error にならない安全側)
 */
export function buildSupportedIdentityProviders(input: {
  readonly cognito: boolean;
  readonly saml?: { readonly providerName: string };
}): aws_cognito.UserPoolClientIdentityProvider[] {
  const out: aws_cognito.UserPoolClientIdentityProvider[] = [];
  if (input.cognito) out.push(aws_cognito.UserPoolClientIdentityProvider.COGNITO);
  if (input.saml) {
    out.push(aws_cognito.UserPoolClientIdentityProvider.custom(input.saml.providerName));
  }
  if (out.length === 0) {
    out.push(aws_cognito.UserPoolClientIdentityProvider.COGNITO);
  }
  return out;
}
