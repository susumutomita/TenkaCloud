import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { SignInAuditLambda } from "../control-plane/sign-in-audit-lambda.js";
import { AdminInsightApiLambda } from "./admin-insight-api-lambda.js";

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
  /**
   * Issue #814 Phase 2: SBT BashJobRunner の deprovisioning state machine ARN。
   * admin-insight Lambda が \`states:ListExecutions\` で実行履歴を取得し、 admin-console の
   * Deprovisioning Jobs タブで参加者運営に見せる。 未指定なら route は未配線 (= legacy 互換)。
   */
  readonly deprovisioningStateMachineArn?: string;
  /**
   * Issue #950 (ADR-020 Phase D): admin 操作の audit log table。 ProblemDeployBackendStack で
   * 作成された Table を cross-stack read で渡す。 未指定なら admin-insight の audit route は 503
   * (= 旧 stack 互換)。
   */
  readonly adminAuditLogTable?: Table;
  /**
   * Issue #1335 Phase 1: sign-in audit Lambda の env (`SYSTEM#<env>` suffix と一致)。
   * `cognitoUserPool` + `adminAuditLogTable` が両方ある場合のみ SignInAuditLambda を attach する。
   * 未指定 (= 既存テスト) なら audit Lambda は作らない (= 後方互換)。
   */
  readonly environmentName?: string;
  /**
   * SOC2 1-year retention 用 env (= `AUDIT_RETENTION_DAYS=365`)。
   * 未指定なら 90 日 default (OSS / self-hosted)。
   */
  readonly auditRetentionDays?: number;
  /**
   * Issue #1340 Phase 2: per-tenant sign-in audit を attach する tenant 群。 各エントリは
   *   - `tenantId` (= `TENANT#<tenantId>` partition)
   *   - `userPoolId` (= CloudTrail event filter で使う文字列 ID、 cross-stack ref で TenantTemplateStack
   *     / TenkaCloudLiteStack から渡す)
   * を持つ。 空 / 未指定なら audit Lambda は作らない (= 後方互換、 Phase 1 のみ動作)。
   *
   * 同 stack に集約する理由: `adminAuditLogTable` は ProblemDeployBackendStack 所有で、 cross-stack
   * ref として AdminConsoleInsightStack に流れている。 tenant 側 stack から adminAuditLogTable を
   * 直接読みに行くと逆向きの cross-stack ref が増え cyclic 化する。 AdminConsoleInsightStack は
   * Control Plane (Phase 1 audit Lambda) + Application Plane (Phase 2 audit Lambda) の両方を
   * 同じ table に書き込ませる **観測ハブ** として位置付ける (= ADR-011 D6 の admin insight 集約)。
   */
  readonly tenantSignInAudit?: ReadonlyArray<{
    readonly tenantId: string;
    readonly userPoolId: string;
  }>;
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
  /** Admin Insight HTTP API ID for CloudWatch metrics. */
  public readonly apiId: string;
  /** Admin Insight Lambda function name for CloudWatch metrics. */
  public readonly lambdaFunctionName: string;

  constructor(scope: Construct, id: string, props: AdminConsoleInsightStackProps) {
    super(scope, id, props);

    const lambda = new AdminInsightApiLambda(this, "AdminInsightApiLambda", {
      deploymentsTable: props.deploymentsTable,
      eventsTable: props.eventsTable,
      teamsTable: props.teamsTable,
      // Issue #949: SystemAdmin user CRUD のため ControlPlane UserPool を渡す。
      // Lambda は env CONTROL_PLANE_USER_POOL_ID + IAM Allow を取得し、
      // /admin/insight/system-users route 群を実装する。
      controlPlaneUserPool: props.cognitoUserPool,
      ...(props.deprovisioningStateMachineArn
        ? { deprovisioningStateMachineArn: props.deprovisioningStateMachineArn }
        : {}),
      // Issue #950: admin audit log table の read-only access
      ...(props.adminAuditLogTable ? { adminAuditLogTable: props.adminAuditLogTable } : {}),
      ...(props.auditRetentionDays !== undefined
        ? { auditRetentionDays: props.auditRetentionDays }
        : {}),
    });
    this.lambdaFunctionName = lambda.fn.functionName;

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
        // Issue #949: SystemAdmin user CRUD で POST / DELETE / PATCH が要るため CORS allow を拡張。
        // 既存 read-only routes は GET のみで動くので影響なし (= preflight allowMethods は superset)。
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.OPTIONS,
        ],
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

    // Issue #658: Provisioning Jobs page が叩く CodePipeline 実行履歴 route。
    // PR-683 で Lambda handler / IAM は追加したが API GW route 登録漏れで "Failed to fetch"
    // (= CORS preflight が 404 に当たって TypeError) が出ていた。本 PR で追加。
    httpApi.addRoutes({
      path: "/admin/insight/pipeline-executions",
      methods: [HttpMethod.GET],
      integration,
    });

    // Issue #814 Phase 2: Deprovisioning Jobs ページが叩く Step Functions ListExecutions route。
    // SBT BashJobRunner の deprovisioning state machine の execution 履歴を返す。
    httpApi.addRoutes({
      path: "/admin/insight/state-machine-executions",
      methods: [HttpMethod.GET],
      integration,
    });

    // Issue #949 (ADR-020 Phase C): SystemAdmin user の CRUD route 群。
    // 全 route で JWT Authorizer + handler 内の `cognito:groups ⊇ {SystemAdmin}` の 2 段 check で
    // 認可する。 list / detail は SystemAuditor も pass、 mutate (POST / DELETE / PATCH) は
    // SystemAdmin only にする予定 (= handler 内 granular gate)。
    httpApi.addRoutes({
      path: "/admin/insight/system-users",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration,
    });
    httpApi.addRoutes({
      path: "/admin/insight/system-users/{username}",
      methods: [HttpMethod.GET, HttpMethod.DELETE, HttpMethod.PATCH],
      integration,
    });

    // Issue #950 (ADR-020 Phase D): admin audit log read route (= cross-tenant 監査)
    httpApi.addRoutes({
      path: "/admin/insight/audit",
      methods: [HttpMethod.GET],
      integration,
    });
    httpApi.addRoutes({
      path: "/admin/insight/audit/export",
      methods: [HttpMethod.GET],
      integration,
    });

    // Issue #1335 Phase 1: Control Plane Cognito sign-in events を CloudTrail / EventBridge 経由で
    // listen し、 AdminAuditLogTable に audit 行を書き出す Lambda + Rule。 UserPool への直接の
    // trigger 配線 (= addTrigger) は ControlPlane → ProblemDeploy → ControlPlane の循環依存を
    // 引き起こすため避け、 string ID 一致で event filter する設計に揃える。
    if (props.adminAuditLogTable && props.environmentName) {
      new SignInAuditLambda(this, "SignInAudit", {
        userPoolId: props.cognitoUserPool.userPoolId,
        adminAuditLogTable: props.adminAuditLogTable,
        environmentName: props.environmentName,
        // Phase 1 は tenantId 未指定 → handler が SYSTEM にフォールバック (= 既存挙動)。
      });
    }

    // Issue #1340 Phase 2: per-tenant SAML sign-in events も同 audit log table に書く。
    // `tenantSignInAudit` は 0..N tenant の (tenantId, userPoolId) pair を持ち、 tenant ごとに
    // CloudTrail Cognito event filter + Lambda + EventBridge Rule を 1 セット立てる。
    // 各 Lambda には AUDIT_TENANT_ID env を渡し、 `TENANT#<tenantId>` partition に書く。
    if (props.adminAuditLogTable && props.environmentName && props.tenantSignInAudit) {
      for (const tenant of props.tenantSignInAudit) {
        // construct id は tenantId を含めて衝突回避 (= ULID / "pooled" / "local" のいずれも CFn 識別子に使える)。
        // `.` / 非英数 はサニタイズ済の前提 (= ULID / 既知 reserved tenantId 規約)。
        new SignInAuditLambda(this, `SignInAudit-${tenant.tenantId}`, {
          userPoolId: tenant.userPoolId,
          adminAuditLogTable: props.adminAuditLogTable,
          environmentName: props.environmentName,
          auditTenantId: tenant.tenantId,
        });
      }
    }

    this.apiUrl = httpApi.apiEndpoint;
    this.apiId = httpApi.apiId;

    new CfnOutput(this, "AdminInsightApiUrl", {
      value: httpApi.apiEndpoint,
      description:
        "Admin Insight HTTP API のエンドポイント (admin-console の runtime-config.json に注入する)。",
    });
  }
}
