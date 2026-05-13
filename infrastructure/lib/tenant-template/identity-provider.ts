import { aws_cognito, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
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
      },
    });

    const stack = Stack.of(this);
    const domainPrefix = buildCognitoDomainPrefix(props.environment, props.tenantId, stack.account);
    this.tenantUserPoolDomain = this.tenantUserPool.addDomain("tenantUserPoolDomain", {
      cognitoDomain: { domainPrefix },
    });
    this.cognitoDomainUrl = `https://${domainPrefix}.auth.${stack.region}.amazoncognito.com`;

    // `custom:tenantId` / `userRole` / `apiKey` / `tenantTier` は admin (provision-tenant.sh
    // が `admin-create-user` で初期化、必要なら `admin-update-user-attributes` で更新) のみ
    // 書き換える。Client の `writeAttributes` から外すことで、ユーザの access_token から
    // `UpdateUserAttributes` で `custom:tenantId` を別テナントに書き換えてクロステナント
    // 操作する経路を塞ぐ (Deploy API の JWT authorizer が claim を信頼するため)。
    const writeAttributes = new aws_cognito.ClientAttributes().withStandardAttributes({
      email: true,
    });

    // Issue #686 (root cause): id_token に `custom:tenantId` が乗らず deploy 経路で
    // tenant 識別ができなかった。 Cognito の readAttributes が unset だと default で全
    // 標準 attribute が読めるが、 **custom: は明示的に追加しないと id_token claim に
    // 出ない**。 readAttributes に `custom:tenantId` 等を明示する。
    const readAttributes = new aws_cognito.ClientAttributes()
      .withStandardAttributes({
        email: true,
        emailVerified: true,
      })
      .withCustomAttributes("tenantId", "userRole", "apiKey", "tenantTier");

    this.tenantUserPoolClient = new aws_cognito.UserPoolClient(this, "tenantUserPoolClient", {
      userPool: this.tenantUserPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        adminUserPassword: false,
        userSrp: true,
        custom: false,
      },
      writeAttributes: writeAttributes,
      readAttributes: readAttributes,
      oAuth: {
        scopes: [
          aws_cognito.OAuthScope.EMAIL,
          aws_cognito.OAuthScope.OPENID,
          aws_cognito.OAuthScope.PROFILE,
        ],
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        callbackUrls: [
          `${props.applicationAdminConsoleUrl}/callback`,
          // dev (apps/application-admin-console を make dev で立てる場合)
          "http://localhost:5174/callback",
        ],
        logoutUrls: [`${props.applicationAdminConsoleUrl}/`, "http://localhost:5174/"],
      },
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
