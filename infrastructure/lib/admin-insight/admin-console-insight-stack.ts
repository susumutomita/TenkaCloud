import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { AdminInsightApiLambda } from "./admin-insight-api-lambda";

export interface AdminConsoleInsightStackProps extends cdk.StackProps {
  /**
   * SBT ControlPlane の Cognito UserPool。System Admin が登録される pool。
   * HTTP API JWT Authorizer の audience に渡す。
   */
  readonly cognitoUserPool: IUserPool;
  /**
   * SBT 内蔵 UserPoolUserClient の client ID (= admin-console が OAuth Code+PKCE で使う client)。
   * JWT Authorizer は本 client を audience とみなして token を検証する。
   */
  readonly cognitoUserClientId: string;
  /**
   * 問題 deploy 状況 (active / failed) を集計するため `ProblemDeployBackendStack` の
   * Deployments table を cross-stack 参照する。Read-only。
   */
  readonly deploymentsTable: Table;
  /**
   * 競技 Event の総数を集計するため `ProblemDeployBackendStack` の Events table を
   * cross-stack 参照する。Read-only。
   */
  readonly eventsTable: Table;
  /**
   * Phase 1.B 以降の drill-down で読む Teams table。Phase 1.A では env として渡すのみ
   * (Lambda 側で read 権限は付与しない、ADR-011 D6 最小権限)。
   */
  readonly teamsTable: Table;
  /**
   * admin-console (System Admin SPA) の CloudFront origin。CORS allow-list に明示する。
   * 未設定 (= phase 1 初回 deploy 時) は localhost dev origin のみ許可。
   */
  readonly adminConsoleOrigin?: string;
}

/**
 * Admin Console Insight Stack (ADR-011 / issue #590 Phase 1.A)。
 *
 * System Admin が tenant 横断で deploy 進捗を観察するための専用 HTTP API + Lambda を提供する。
 *
 * 設計判断 (ADR-011 から):
 * - **D1 採用**: 新 Lambda + 新 API を立てる (= 既存 tenant API に admin 例外を漏らさない)
 * - **D2 採用**: SBT 標準 SystemAdmin group の Cognito claim で authorize。JWT Authorizer
 *   (1 段目) + handler 内の claim 再検査 (2 段目) で 403 を返す
 * - **D6 Phase 1**: read-only に限定 (write は別 ADR が必要)
 *
 * 物理影響:
 * - HTTP API (API GW v2) 1 個 + Lambda 1 個 + JWT Authorizer 1 個。新 table は無し
 * - Free Tier 内で完結 (= API GW v2 100 万 req/月 free、Lambda 100 万 req + 400k GB-s free)
 */
export class AdminConsoleInsightStack extends cdk.Stack {
  /**
   * Admin Insight HTTP API の base URL (例: `https://abc.execute-api.ap-northeast-1.amazonaws.com`)。
   * admin-console の runtime-config.json に注入される。
   */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: AdminConsoleInsightStackProps) {
    super(scope, id, props);

    const lambda = new AdminInsightApiLambda(this, "AdminInsightApiLambda", {
      deploymentsTable: props.deploymentsTable,
      eventsTable: props.eventsTable,
      teamsTable: props.teamsTable,
    });

    // JWT Authorizer: ControlPlane UserPool の token を検証する。
    // (= cognito:groups claim の SystemAdmin チェックは handler 側で実施する 2 段防御)
    const authorizer = new HttpUserPoolAuthorizer("AdminInsightAuthorizer", props.cognitoUserPool, {
      userPoolClients: [
        // SBT が払い出した admin 用 client。`fromUserPoolClientId` を使うには別途
        // UserPoolClient 参照が要るので、ControlPlaneStack で expose した client id を
        // identitySource の audience matcher として使う。
        cdk.aws_cognito.UserPoolClient.fromUserPoolClientId(
          this,
          "AdminInsightUserPoolClient",
          props.cognitoUserClientId,
        ),
      ],
      authorizerName: "AdminInsightSystemAdminAuth",
    });

    const allowOrigins = [
      // localhost dev ports — ControlPlaneStack の LOCALHOST_CORS_ORIGINS と揃える。
      "http://localhost:5173",
      "http://localhost:4173",
      "http://localhost:4180",
      ...(props.adminConsoleOrigin ? [props.adminConsoleOrigin] : []),
    ];

    const httpApi = new HttpApi(this, "AdminInsightHttpApi", {
      apiName: `admin-insight-${this.stackName}`,
      description:
        "TenkaCloud Admin Insight API (ADR-011 Phase 1.A). System Admin が tenant 横断で deploy 進捗を read する経路。",
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins,
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.OPTIONS],
        maxAge: cdk.Duration.minutes(10),
      },
    });

    const integration = new HttpLambdaIntegration("AdminInsightLambdaIntegration", lambda.fn);

    httpApi.addRoutes({
      path: "/admin/insight/tenants/summary",
      methods: [HttpMethod.GET],
      integration,
    });

    // Phase 1.B drill-down routes (#598)。
    // 全 route は同じ Lambda integration / JWT Authorizer に接続される (= 1 Lambda で
    // 全 path を受ける Hono ルーティング)。
    httpApi.addRoutes({
      path: "/admin/insight/tenants/{tenantId}/events",
      methods: [HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: "/admin/insight/tenants/{tenantId}/events/{eventId}",
      methods: [HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: "/admin/insight/tenants/{tenantId}/deployments/{jobId}",
      methods: [HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: "/admin/insight/tenants/{tenantId}/deployments/{jobId}/stack-progress",
      methods: [HttpMethod.GET],
      integration,
    });

    this.apiUrl = httpApi.apiEndpoint;

    new CfnOutput(this, "AdminInsightApiUrl", {
      value: httpApi.apiEndpoint,
      description:
        "Admin Insight HTTP API のエンドポイント (admin-console の runtime-config.json に注入する)。",
    });
  }
}
