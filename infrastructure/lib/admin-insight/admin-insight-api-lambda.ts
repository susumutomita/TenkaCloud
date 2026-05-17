import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime";

export interface AdminInsightApiLambdaProps {
  /**
   * 問題 deploy 状況 (active / failed 集計) の出元。`ProblemDeployBackendStack` の
   * `Deployments` table を cross-stack 参照する。Read-only (= ADR-011 D6 Phase 1 は read-only)。
   */
  readonly deploymentsTable: Table;
  /**
   * 競技 Event 総数の出元。`ProblemDeployBackendStack` の `Events` table を cross-stack 参照する。
   * Read-only。
   */
  readonly eventsTable: Table;
  /**
   * Phase 1.B drill-down で読み取り対象になる Teams table (#598)。
   * EventDetail の teams[] を組み立てるのに read 権限を付与する (= read-only)。
   * teamLoginKey は handler 層で undefined に潰すため、本 IAM では projection 制限を
   * かけない (= GetItem/Query レベルで全 attribute を引けるが、handler が出口で塗りつぶす)。
   */
  readonly teamsTable: Table;
  /**
   * Issue #814 Phase 2: SBT BashJobRunner の deprovisioning state machine ARN。
   * 指定時は \`states:ListExecutions\` 権限と env を付与し、 admin-insight handler が
   * Deprovisioning Jobs route で履歴を返せるようにする。 未指定なら旧挙動 (= 該当 route は env なしで
   * 503 を返す or placeholder)。
   */
  readonly deprovisioningStateMachineArn?: string;
}

/**
 * Admin Insight API Lambda (ADR-011 / issue #590 Phase 1.A)。
 *
 * System Admin が admin-console から cross-tenant に deploy 進捗を見る経路。
 * tenant 専用 Lambda (= DeployApi / EventApi) と分離して認可境界を明確にする (ADR-011 D1 採用案)。
 *
 * routes (Phase 1.A):
 *   GET /admin/insight/tenants/summary?tenantIds=t1,t2,t3
 *     → per-tenant の activeDeploys / failedDeploys / totalEvents 集計
 *
 * Auth: 呼び出し側の AdminConsoleInsightStack で HTTP API + JWT Authorizer (ControlPlane
 * UserPool) を結線する。Handler は更に `cognito:groups` ⊇ {SystemAdmin} の claim 検査を行う。
 */
export class AdminInsightApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AdminInsightApiLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/admin-insight-handler/index.ts"),
      handler: "handler",
      // Per-tenant Query を Promise.all で並列発火するので、tenant 数 100 件 × DDB 往復 ~50ms
      // ≒ 5s が最大。安全側で 15s。
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        EVENTS_TABLE_NAME: props.eventsTable.tableName,
        TEAMS_TABLE_NAME: props.teamsTable.tableName,
        // Issue #814 Phase 2: deprovisioning Step Functions ARN を env に渡す (= 未指定なら空)。
        // handler は env の有無で route を 503 にするか実 SFN.ListExecutions を呼ぶか分岐する。
        DEPROVISIONING_STATE_MACHINE_ARN: props.deprovisioningStateMachineArn ?? "",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // ADR-011 Phase 1 D6: read-only に限定。Phase 1.A は Deployments / Events のみだったが、
    // Phase 1.B drill-down (#598) で Teams も読む必要が出たため read を追加する。
    // GSI も含めて read できる必要があるので grantReadData (= GetItem / Query / Scan + index)
    // を使う (= 個別 PolicyStatement で限定するより SBT 同型の grantRead で十分)。
    props.deploymentsTable.grantReadData(this.fn);
    props.eventsTable.grantReadData(this.fn);
    props.teamsTable.grantReadData(this.fn);

    // Phase 1.B (#598) CFn Describe: deploy job 詳細ページの "Stack 進行状況" セクションが
    // DescribeStackEvents / DescribeStackResources を直接叩く。Resource:* なのは、CFn の
    // これら API は ARN ベースの IAM 絞り込みをサポートしていない (= account 内全 stack に
    // 同列で適用される) ため。同一 account 内のみで、cross-account は ExternalId 経由の
    // AssumeRole が別途必要 (= Phase 2 ADR-011 D4 で実装)。
    this.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources"],
        resources: ["*"],
      }),
    );

    // Issue #658: Provisioning Jobs page が tenkacloud-saas-pipeline の execution 履歴を
    // 引くため CodePipeline read 権限を付与。 ListPipelineExecutions は ARN ベースの絞り込みが
    // 可能なので最小権限で固定。 GetPipelineExecution は将来の "Failed phase 詳細" routes 用。
    // Issue #857 justify: codepipeline:ListPipelineExecutions は ARN 必須だが、 同 stack 内で
    // pipeline ARN を循環参照しないために `*` で残す。 read-only 操作で blast radius 限定的。
    this.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["codepipeline:ListPipelineExecutions", "codepipeline:GetPipelineExecution"],
        resources: ["*"],
      }),
    );

    // Issue #814 Phase 2: Deprovisioning Jobs route の Step Functions ListExecutions 権限。
    // 指定された SBT BashJobRunner の state machine ARN に scope する。 未指定なら付与しない
    // (= 旧 stack の互換維持)。 DescribeExecution は将来の "Failed step 詳細" 用に同梱。
    if (props.deprovisioningStateMachineArn) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["states:ListExecutions", "states:DescribeExecution"],
          resources: [
            props.deprovisioningStateMachineArn,
            // DescribeExecution は execution ARN を要求する。 同 state machine 配下の全 execution
            // を許可するため `<sm-arn>:*` で wildcard。
            `${props.deprovisioningStateMachineArn}:*`,
            // execution ARN は実際には `arn:aws:states:<region>:<acct>:execution:<sm-name>:<id>` 形式で
            // state-machine の prefix と異なる。 両方含めて grant。
            props.deprovisioningStateMachineArn
              .replace(":stateMachine:", ":execution:")
              .concat(":*"),
          ],
        }),
      );
    }
  }
}
