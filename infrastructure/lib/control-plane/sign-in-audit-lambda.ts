import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface SignInAuditLambdaProps {
  /** ADR-020 Phase D の admin audit log table (= `PK=SYSTEM#<env>` 又は `PK=TENANT#<id>` の sign-in 行を書く)。 */
  readonly adminAuditLogTable: Table;
  /** `SYSTEM#<env>` の env suffix (= writeAuditEvent が `DEPLOY_ENVIRONMENT` を読む)。 */
  readonly environmentName: string;
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
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        CONTROL_PLANE_USER_POOL_ID: props.userPoolId,
        // Issue #1340 Phase 2: tenant 配線時のみ tenantId env を渡す (= 未指定なら handler が
        // SYSTEM にフォールバック、 Phase 1 Control Plane 動作互換)。
        ...(props.auditTenantId ? { AUDIT_TENANT_ID: props.auditTenantId } : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    props.adminAuditLogTable.grantWriteData(this.fn);

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
