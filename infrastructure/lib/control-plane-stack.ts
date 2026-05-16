import { CognitoAuth, ControlPlane } from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import {
  type CfnUserPool,
  type CfnUserPoolClient,
  CfnUserPoolIdentityProvider,
  type IUserPool,
  type UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { SamlIdpConfig } from "./config/config-interface";
import { buildInviteEmailBody, INVITE_EMAIL_SUBJECT } from "./control-plane/invite-message";

interface ControlPlaneStackProps extends cdk.StackProps {
  systemAdminEmail: string;
  /**
   * Issue #839 follow-up: System Admin (= TenkaCloud operator 会社) 用 SAML IdP 連携。
   * SBT が wrap した Cognito UserPool に `CfnUserPoolIdentityProvider` (= SAML) を escape hatch で
   * 後付けし、 UserPoolClient の `SupportedIdentityProviders` に追加する。 未設定なら従来通り
   * username/password。
   */
  samlIdp?: SamlIdpConfig;
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

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, "CognitoAuth", {
      setAPIGWScopes: false, // done for testing purposes. Scopes should be used for added security in production!
    });

    // admin-console の CloudFront URL (install.sh phase 3 で env 経由で注入される)。
    // 最初の deploy 時は未設定、AdminConsoleHostingStack deploy 後に再 deploy で設定される。
    const adminConsoleOrigin = process.env.CDK_PARAM_ADMIN_CONSOLE_ORIGIN;
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

    // Issue #839 follow-up: SBT が wrap した UserPool に SAML IdP を escape hatch で後付け。
    // `CfnUserPoolIdentityProvider` を SBT UserPool の userPoolId 参照で作り、
    // UserPoolClient.SupportedIdentityProviders / authFlow を `addPropertyOverride` で書き換える。
    if (props.samlIdp) {
      const samlIdp = buildControlPlaneSamlIdp(
        this,
        cognitoAuth.userPool.userPoolId,
        props.samlIdp,
      );
      // SupportedIdentityProviders を flip。 `enforceSamlOnly` なら SAML 単独、 そうでなければ
      // COGNITO + SAML 並列 (= Hosted UI に両方の sign-in button が出る)。
      const idps = props.samlIdp.enforceSamlOnly ? [samlIdp.ref] : ["COGNITO", samlIdp.ref];
      cfnUserClient.addPropertyOverride("SupportedIdentityProviders", idps);
      if (props.samlIdp.enforceSamlOnly) {
        // SAML 単独運用のときは password / SRP 経路を完全に閉じる。 SBT default は USER_SRP_AUTH
        // + ADMIN_NO_SRP_AUTH を含むので、 上書きで minimum set (= SAML が要る REFRESH_TOKEN のみ) に絞る。
        cfnUserClient.addPropertyOverride("ExplicitAuthFlows", ["ALLOW_REFRESH_TOKEN_AUTH"]);
      }
      // IdP は UserPoolClient より前に存在する必要がある (= CFn 依存)。
      cfnUserClient.addDependency(samlIdp);
    }

    this.eventBusArn = controlPlane.eventManager.busArn;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
    // SBT CognitoAuth が払い出した UserPool / UserClient を兄弟 stack
    // (AdminConsoleInsightStack) の JWT Authorizer 用に export する。
    this.cognitoUserPool = cognitoAuth.userPool;
    this.cognitoUserClientId = cognitoAuth.userClientId;
  }
}

/**
 * Issue #839 follow-up: SBT-wrapped Cognito UserPool に SAML IdP を escape hatch で追加する。
 * SBT 0.3.9 が UserPool を expose しているので、 そこに `CfnUserPoolIdentityProvider` を直接 attach。
 *
 * AttributeMapping は最低限 email を SAML 標準 namespace から取る。 caller の override があれば優先。
 */
function buildControlPlaneSamlIdp(
  scope: Construct,
  userPoolId: string,
  config: SamlIdpConfig,
): CfnUserPoolIdentityProvider {
  const providerName = config.providerName ?? "CompanySAML";
  const defaultEmail = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
  const userMapping = config.attributeMapping ?? {};
  const attributeMapping: Record<string, string> = {
    email: userMapping.email ?? defaultEmail,
  };
  return new CfnUserPoolIdentityProvider(scope, "SystemAdminSamlIdp", {
    userPoolId,
    providerName,
    providerType: "SAML",
    providerDetails: {
      MetadataURL: config.metadataUrl,
      IDPSignout: "true",
    },
    attributeMapping,
  });
}
