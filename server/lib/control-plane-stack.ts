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
 * AWS SaaS Reference Architecture の control-plane-stack.ts を TenkaCloud の
 * Next.js (NextAuth v5) Admin UI 向けに最小調整したもの。
 * 1. CORS allowOrigins に localhost:13000 (TenkaCloud 開発用 Next.js Control Plane) を追加
 *    (ref は https://* のみで HTTP localhost は弾かれる)
 * 2. SBT 内蔵 UserPoolUserClient の callbackUrls / LogoutURLs を override し、
 *    Next.js の basePath=/control + NextAuth v5 Cognito provider の
 *    `/api/auth/callback/cognito` を許可する
 *    (ref は `http://localhost` プレースホルダ 1 個のみ)
 */
const LOCALHOST_CALLBACK_URLS = [
  "http://localhost:13000/control/api/auth/callback/cognito", // client/AdminWeb (Next.js) NextAuth v5 + basePath
];

const LOCALHOST_LOGOUT_URLS = ["http://localhost:13000/control"];

const LOCALHOST_CORS_ORIGINS = ["http://localhost:13000"];

export class ControlPlaneStack extends cdk.Stack {
  public readonly regApiGatewayUrl: string;
  public readonly eventBusArn: string;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const cognitoAuth = new CognitoAuth(this, "CognitoAuth", {
      setAPIGWScopes: false, // done for testing purposes. Scopes should be used for added security in production!
    });

    // AdminWeb の CloudFront URL (install.sh phase 3 で env 経由で注入される)。
    // 最初の deploy 時は未設定、AdminConsoleHostingStack deploy 後に再 deploy で設定される。
    const adminConsoleOrigin = process.env.CDK_PARAM_ADMIN_CONSOLE_ORIGIN;
    const extraCorsOrigins = adminConsoleOrigin ? [adminConsoleOrigin] : [];
    const extraCallbackUrls = adminConsoleOrigin
      ? [`${adminConsoleOrigin}/control/api/auth/callback/cognito`]
      : [];
    const extraLogoutUrls = adminConsoleOrigin ? [`${adminConsoleOrigin}/control`] : [];

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
    // localhost (Next.js dev) + CloudFront URL + ref デフォルトの 'http://localhost' を許可する。
    const userClient = cognitoAuth.node.findChild("UserPoolUserClient") as UserPoolClient;
    const cfnUserClient = userClient.node.defaultChild as CfnUserPoolClient;
    cfnUserClient.addPropertyOverride("CallbackURLs", [
      "http://localhost",
      ...LOCALHOST_CALLBACK_URLS,
      ...extraCallbackUrls,
    ]);
    cfnUserClient.addPropertyOverride("LogoutURLs", ["http://localhost", ...LOCALHOST_LOGOUT_URLS, ...extraLogoutUrls]);

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
