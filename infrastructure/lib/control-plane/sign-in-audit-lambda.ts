import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { auditLogEnabledEnv } from "../problem-deploy/audit-log-env.js";
import { controlDataBackendEnv } from "../problem-deploy/control-data-backend-env.js";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface SignInAuditLambdaProps {
  /**
   * admin audit log table (`PK=SYSTEM#<env>` 又は `PK=TENANT#<id>` の
   * sign-in 行を書く)。
   *
   * [Issue #2442 / Phase C4] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `ADMIN_AUDIT_LOG_TABLE_NAME` は注入せず grant も付与しない — audit write は repository seam
   * (`writeAuditEvent` → `resolveAdminAuditLogRepository`) が下記の Turso executor 配線経由で
   * 処理する (本 Lambda 自身が「DB を開く Lambda」)。
   */
  readonly adminAuditLogTable?: Table;
  /** `SYSTEM#<env>` の env suffix (= writeAuditEvent が `DEPLOY_ENVIRONMENT` を読む)。 */
  readonly environmentName: string;
  /**
   * [Issue #2442 / Phase C4] Public remote libSQL URL。本 Lambda は `writeAuditEvent` を通じて
   * AdminAuditLog repository seam を実際に使う「DB を開く Lambda」なので Turso executor 配線を
   * 持つ (SystemAuditWriterLambda と同型)。
   */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
  /**
   * Issue #1335 Phase 1: Cognito UserPool ID (= 文字列、 cross-stack ref では無く ARN 一致用)。
   * 本 Lambda は CloudTrail Cognito events を default EventBridge bus 経由で listen するため、
   * UserPool 構造体への直接 ref は持たない (= ControlPlane → ProblemDeploy → ControlPlane の
   * 循環依存を回避)。 文字列 ID で event filter する。
   */
  readonly userPoolId: string;
  /**
   * Issue #1340 Phase 2: 監査行 partition の tenantId。 Control Plane (Phase 1) は未指定で
   * `SYSTEM` 既定にし `SYSTEM#<env>` に書く (= 旧動作互換)。 Application Plane (Phase 2) は
   * tenantId を渡し、 `TENANT#<tenantId>` に書く (= 既存 admin-audit log の規約と整合)。
   * 値は AUDIT_TENANT_ID env として Lambda に流す (= handler が tenant 分岐に使う)。
   */
  readonly auditTenantId?: string;
  /**
   * Issue #2311: 監査ログ feature flag。false で `AUDIT_LOG_ENABLED="false"` を注入し no-op 化。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * [Issue #2442 / Phase C4] control-plane data backend (dynamodb|turso)。 監査 Lambda 群と
   * lockstep で env を配線する (`SystemAuditWriterLambda` と同型)。 default (未指定 /
   * `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
}

/**
 * Issue #1335 Phase 1: Cognito sign-in 成功イベントを CloudTrail / EventBridge 経由で listen し、
 * AdminAuditLogTable の `SYSTEM#<env>` 区画に 1 行 audit 行を書く Lambda + Rule。
 *
 * 設計判断: Pre-Token Generation Lambda trigger ではなく **EventBridge listen** にした理由は、
 * Pre-Token Generation Lambda が UserPool (= ControlPlaneStack 所有) と AdminAuditLogTable
 * (= ProblemDeployBackendStack 所有) の両方を参照する必要があり、 cross-stack ref が
 * 双方向になって stack 依存が循環する (= ControlPlane → ProblemDeploy ← ControlPlane)。
 * 既存 `SystemAuditWriterLambda` (Issue #1034) と同じ pattern で、 CloudTrail Cognito events
 * (= aws.cognito-idp source) を listen することで cross-stack ref を片方向に保つ。
 *
 * 監査属性: action=`auth.sign_in_succeeded`, tenantId=`SYSTEM`, extra.idp=`COGNITO` / federated
 * provider 名。 actor=Cognito sub (= immutable identity)。
 *
 * Coverage trade-off: CloudTrail Cognito events は Hosted UI 経由 vs admin API 経由で
 * 出方が異なる (= 一部 sign-in 経路は network call を伴わない)。 Phase 6 で必要に応じて
 * Cognito Advanced Security events (= EventBridge 直結 native) で補完予定。
 */
export class SignInAuditLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: SignInAuditLambdaProps) {
    super(scope, id);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/sign-in-audit/index.ts"),
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        // [Issue #2442] 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.adminAuditLogTable
          ? { ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable.tableName }
          : {}),
        DEPLOY_ENVIRONMENT: props.environmentName,
        CONTROL_PLANE_USER_POOL_ID: props.userPoolId,
        // Issue #1340 Phase 2: tenant 配線時のみ tenantId env を渡す (= 未指定なら handler が
        // SYSTEM にフォールバック、 Phase 1 Control Plane 動作互換)。
        ...(props.auditTenantId ? { AUDIT_TENANT_ID: props.auditTenantId } : {}),
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        // Issue #2442: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // [Issue #2442] 純 SQL backend では table 自体が無いので grant も付与しない。
    props.adminAuditLogTable?.grantWriteData(this.fn);

    // [Issue #2442]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`SystemAuditWriterLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${Stack.of(this).partition}:ssm:${Stack.of(this).region}:${
              Stack.of(this).account
            }:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }

    // CloudTrail Cognito events は default event bus に流れる (= aws.cognito-idp source)。
    // Cognito sign-in (= managed login / Hosted UI) は CloudTrail event Name = "InitiateAuth"
    // または "RespondToAuthChallenge" として記録される。 federated SAML callback は
    // "Authenticate" / "TokenEndpoint" 経由になる場合もあるため、 event filter は
    // pool-id だけで絞り、 handler 側で event name + responseElements の有無で判定する。
    this.rule = new Rule(this, "Rule", {
      description:
        "Route Cognito sign-in CloudTrail events from the Control Plane UserPool to the sign-in audit writer (Issue #1335)",
      eventPattern: {
        source: ["aws.cognito-idp"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          // event filter は pool id を含む request param で絞る。 federated / local の両経路を
          // 単一 rule で catch するため eventName は handler 側で振り分ける (= 過剰 filter で
          // 経路を取り逃がすより、 一旦 catch して handler で判別する方が漏れにくい)。
          requestParameters: {
            userPoolId: [props.userPoolId],
          },
        },
      },
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
