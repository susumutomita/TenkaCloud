import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { auditLogEnabledEnv } from "../problem-deploy/audit-log-env.js";
import { controlDataBackendEnv } from "../problem-deploy/control-data-backend-env.js";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface AdminInsightApiLambdaProps {
  /**
   * 問題 deploy 状況 (active / failed 集計) の出元。`ProblemDeployBackendStack` の
   * `Deployments` table を cross-stack の read-only 参照として使う。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * grant も付与しない — deploy 状況集計は repository seam (`resolveDeploymentsRepository` /
   * `countActiveByTenant`) が SQL executor 直結で処理する ({@link eventsTable} と同じ条件)。
   */
  readonly deploymentsTable?: Table;
  /**
   * 競技 Event 総数の出元。`ProblemDeployBackendStack` の `Events` table を cross-stack 参照する。
   * Read-only。
   *
   * [Issue #2440] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env
   * `EVENTS_TABLE_NAME` も grant も付与しない — Events 集計は repository seam
   * (`resolveEventsRepository` / injected runtime) が SQL executor 直結で処理する。
   */
  readonly eventsTable?: Table;
  /**
   * Phase 1.B drill-down で読み取り対象になる Teams table (#598)。
   * EventDetail の teams[] を組み立てるのに read 権限を付与する (= read-only)。
   * teamLoginKey は handler 層で undefined に潰すため、本 IAM では projection 制限を
   * かけない (= GetItem/Query レベルで全 attribute を引けるが、handler が出口で塗りつぶす)。
   * {@link eventsTable} と同じ条件で純 SQL backend 選択時は `undefined`。
   */
  readonly teamsTable?: Table;
  /**
   * Issue #814 Phase 2: SBT BashJobRunner の deprovisioning state machine ARN。
   * 指定時は \`states:ListExecutions\` 権限と env を付与し、 admin-insight handler が
   * Deprovisioning Jobs route で履歴を返せるようにする。 未指定なら旧挙動 (= 該当 route は env なしで
   * 503 を返す or placeholder)。
   */
  readonly deprovisioningStateMachineArn?: string;
  /**
   * SBT ProvisioningScriptJob の state machine ARN。 テナントのプロビジョニングが実際に走るのは
   * ここで、 「プロビジョニング Jobs」 画面が見ていた CodePipeline とは別経路 (= 3 テナントを
   * provisioning しても画面に 1 件も出なかった原因)。 deprovisioning と同じ扱いで、 指定時のみ
   * env + `states:ListExecutions` を付与する。
   */
  readonly provisioningStateMachineArn?: string;
  /**
   * Issue #950: admin audit log table。 指定時は SystemAdmin が
   * /admin/insight/audit route で cross-tenant に audit を読めるようになる (= read-only)。
   * 未指定なら route は 503 を返す (= 旧 stack 互換)。
   */
  readonly adminAuditLogTable?: Table;
  /**
   * SOC2 1-year retention env (= `AUDIT_RETENTION_DAYS`)。 enterprise / hosted は `365` を渡す。
   * 未指定なら handler default の 90 日 (= OSS / self-hosted)。
   */
  readonly auditRetentionDays?: number;
  /**
   * Issue #2311: 監査ログ feature flag。false で `AUDIT_LOG_ENABLED="false"` を注入し no-op 化。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #1431: in-console cost visibility。 `CostBudget` が作る月次予算名 (= `<prefix>-monthly-cost`)。
   * 指定時は handler が AWS Budgets `DescribeBudget` (無料) で消化率を返す。 未指定なら
   * `/admin/insight/cost` は `available:false` を返す (= cost-zero、 Cost Explorer は使わない)。
   */
  readonly costBudgetName?: string;
  /**
   * `DescribeBudget` に必須の AWS account id。 `costBudgetName` 指定時のみ使う。 Stack の account
   * を渡す (env-agnostic token なら deploy 時に解決される)。
   */
  readonly costBudgetAccountId?: string;
  /**
   * [Issue #2438 / Phase A3 / #2450] control-plane data backend (dynamodb|turso)。
   * `summary.ts` の `countTenantEvents` が Events repository seam を組み立てる際に読む。
   * default (未指定 / `dynamodb`) は env を足さず byte 互換 — env 注入のメカニズム自体は
   * `EventApiLambda` と同型。
   *
   * `"turso"` 指定時は handler 層 (`admin-insight-handler/shared.ts` の
   * `resolveEventsRepository`) が cold-start cache 済みの async resolver (injected runtime)
   * 経由で SQL repository を解決するため、 `/admin/insight/tenants/summary` は正しく動作する。
   * Turso auth token を読む SSM read 権限は
   * `tursoAuthTokenParameterName` 指定時にのみ付与される (下記 `ssm:GetParameter` policy)。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * Admin Insight API Lambda (issue #590)。
 *
 * System Admin が admin-console から cross-tenant に deploy 進捗を見る経路。
 * tenant 専用 Lambda (DeployApi / EventApi) と分離して認可境界を明確にする。
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

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/admin-insight-handler/index.ts"),
      // Per-tenant Query を Promise.all で並列発火するので、tenant 数 100 件 × DDB 往復 ~50ms
      // ≒ 5s が最大。安全側で 15s。
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.deploymentsTable
          ? { DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName }
          : {}),
        // Issue #2440: 純 SQL backend では table が無いので env も足さない。
        ...(props.eventsTable ? { EVENTS_TABLE_NAME: props.eventsTable.tableName } : {}),
        ...(props.teamsTable ? { TEAMS_TABLE_NAME: props.teamsTable.tableName } : {}),
        // Issue #814 Phase 2: deprovisioning Step Functions ARN を env に渡す (= 未指定なら空)。
        // handler は env の有無で route を 503 にするか実 SFN.ListExecutions を呼ぶか分岐する。
        DEPROVISIONING_STATE_MACHINE_ARN: props.deprovisioningStateMachineArn ?? "",
        PROVISIONING_STATE_MACHINE_ARN: props.provisioningStateMachineArn ?? "",
        // Issue #950: admin audit log table 名 (read-only 経由で表示)
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable?.tableName ?? "",
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        ...(props.auditRetentionDays !== undefined
          ? { AUDIT_RETENTION_DAYS: String(props.auditRetentionDays) }
          : {}),
        // Issue #1431: AWS Budgets DescribeBudget で月次コスト消化率を返す (= 無料 API)。
        // 未指定なら空 → handler は available:false (= 外部リンク表示) に倒す。
        COST_BUDGET_NAME: props.costBudgetName ?? "",
        COST_BUDGET_ACCOUNT_ID: props.costBudgetAccountId ?? "",
        // [Issue #2438]: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // read-only に限定する。当初の Deployments / Events に加え、drill-down (#598) で
    // Teams も読むため read 権限を付与する。
    // GSI も含めて read できる必要があるので grantReadData (= GetItem / Query / Scan + index)
    // を使う (= 個別 PolicyStatement で限定するより SBT 同型の grantRead で十分)。
    // Issue #2441: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.deploymentsTable?.grantReadData(this.fn);
    // Issue #2440: 純 SQL backend では table 自体が無いので grant も付与しない。
    props.eventsTable?.grantReadData(this.fn);
    // Issue #950: admin audit log の read-only access (GSI も含む)
    props.adminAuditLogTable?.grantReadData(this.fn);
    props.teamsTable?.grantReadData(this.fn);

    // Phase 1.B (#598) CFn Describe: deploy job 詳細ページの "Stack 進行状況" セクションが
    // DescribeStackEvents / DescribeStackResources を直接叩く。Resource:* なのは、CFn の
    // これら API は ARN ベースの IAM 絞り込みをサポートしていない (= account 内全 stack に
    // 同列で適用される) ため。同一 account 内のみで、cross-account は ExternalId 経由の
    // AssumeRole 経路を別途実装する必要がある。
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

    // #1392: `/admin/insight/system-users*` routes は handler から削除済のため、 それ専用だった
    // ControlPlane UserPool への `cognito-idp:Admin*` 権限 (旧 Issue #949) も撤去した。 未使用の
    // standing privilege を残さず、 route 再追加時に再 review を強制する。

    // Issue #814 Phase 2: Deprovisioning Jobs route の Step Functions ListExecutions 権限。
    // 指定された SBT BashJobRunner の state machine ARN に scope する。 未指定なら付与しない
    // (= 旧 stack の互換維持)。 DescribeExecution は将来の "Failed step 詳細" 用に同梱。
    // provisioning / deprovisioning とも同じ形の grant なので、 片方だけ追加して権限を落とす事故を
    // 避けるため 1 か所にまとめる。 未指定の ARN は grant しない (= 旧 stack の互換維持)。
    for (const stateMachineArn of [
      props.deprovisioningStateMachineArn,
      props.provisioningStateMachineArn,
    ]) {
      if (!stateMachineArn) {
        continue;
      }
      this.fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["states:ListExecutions", "states:DescribeExecution"],
          resources: [
            stateMachineArn,
            // DescribeExecution は execution ARN を要求する。 同 state machine 配下の全 execution
            // を許可するため `<sm-arn>:*` で wildcard。
            `${stateMachineArn}:*`,
            // execution ARN は実際には `arn:aws:states:<region>:<acct>:execution:<sm-name>:<id>` 形式で
            // state-machine の prefix と異なる。 両方含めて grant。
            stateMachineArn.replace(":stateMachine:", ":execution:").concat(":*"),
          ],
        }),
      );
    }

    // Issue #1431: in-console cost visibility。 AWS Budgets DescribeBudget は無料 (Cost Explorer
    // GetCostAndUsage は $0.01/req のため cost-zero 原則で使わない)。 budget は global service なので
    // ARN に region を含まない。 単一の月次予算 ARN に scope して最小権限で固定。
    if (props.costBudgetName && props.costBudgetAccountId) {
      this.fn.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["budgets:ViewBudget"],
          resources: [
            `arn:aws:budgets::${props.costBudgetAccountId}:budget/${props.costBudgetName}`,
          ],
        }),
      );
    }

    // [Issue #2438]: turso backend が Turso auth token を読むための SSM SecureString
    // read 権限。 未配線 (= dynamodb default) なら付与しない (`EventApiLambda` と同型)。
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
  }
}
