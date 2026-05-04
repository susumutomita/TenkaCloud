import { CognitoAuth, ControlPlane } from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import type { CfnUserPoolClient, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

interface ControlPlaneStackProps extends cdk.StackProps {
  systemAdminEmail: string;
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
    // localhost 多ポート + CloudFront URL + ref デフォルトの 'http://localhost' を許可する。
    const userClient = cognitoAuth.node.findChild("UserPoolUserClient") as UserPoolClient;
    const cfnUserClient = userClient.node.defaultChild as CfnUserPoolClient;
    cfnUserClient.addPropertyOverride("CallbackURLs", [
      "http://localhost",
      ...LOCALHOST_CALLBACK_URLS,
      ...extraCallbackUrls,
    ]);
    cfnUserClient.addPropertyOverride("LogoutURLs", [
      "http://localhost",
      ...LOCALHOST_LOGOUT_URLS,
      ...extraLogoutUrls,
    ]);

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

    this.eventBusArn = controlPlane.eventManager.busArn;
    this.regApiGatewayUrl = controlPlane.controlPlaneAPIGatewayUrl;
  }
}
