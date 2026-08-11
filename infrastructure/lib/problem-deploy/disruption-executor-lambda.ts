import * as path from "node:path";
import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface DisruptionExecutorLambdaProps {
  readonly environmentName: string;
  /** disruption-fire が `*DisruptionFired` を publish する EventBus。 本 Lambda がその rule の target。 */
  readonly eventBus: IEventBus;
  /**
   * team deployment 解決 (GSI1 Query) 用。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * GSI1 Query IAM も付与しない — team deployment 解決は repository seam
   * (`resolveDeploymentsRepository`) が SQL executor 直結で処理する
   * (`executor-store.ts` は既に seam 経由)。
   */
  readonly deploymentsTable?: ITable;
  /**
   * EXEC# 冪等行 (conditional Put) 用。 fire の REQUEST#/AUDIT# と同居。
   *
   * [Issue #2442 / Phase C3] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合 env も
   * PutItem IAM も付与しない — EXEC# claim は repository seam (`resolveDisruptionsRepository`)
   * が本 Lambda に配線する Turso executor (下記) 経由で処理する ({@link deploymentsTable} と
   * 同じ条件)。
   */
  readonly disruptionsTable?: ITable;
  /** `{ [problemId]: ProblemDisruptionEntry[] }` (action 込)。 build 時 literal 置換で env 4KB を回避。 */
  readonly problemsDisruptions?: Readonly<Record<string, unknown>>;
  /**
   * [Issue #2442 / Phase C3] control-plane data backend (dynamodb|turso)。
   * `claimExecution` の repository seam がこの env を読む。default (未指定 /
   * `dynamodb`) は env を足さず byte 互換。`EventApiLambda` と同型の注入パターン。
   */
  readonly controlDataBackend?: string;
  /** Public remote libSQL URL. Never contains authentication material. */
  readonly tursoDatabaseUrl?: string;
  /** SSM SecureString parameter name containing the libSQL auth token. */
  readonly tursoAuthTokenParameterName?: string;
}

/**
 * [Issue #1419] cross-account disruption executor Lambda。
 *
 * EventBridge `tenantcloud.disruptions` source の `*DisruptionFired` を拾い、 該当 team deployment へ
 * AssumeRole して実障害を注入し、注入後は必ず自動復旧を aws-scheduler に予約する。注入の破壊力は
 * **競技者側 CompetitorDeployRole (AdministratorAccess)** に由来し、 本 Lambda 自身の IAM は最小:
 *   - sts:AssumeRole は `TenkaCloud-*` ロールのみ (= deploy worker / describe-stack と同 scope)
 *   - ssm:GetParameter + kms:Decrypt は tenant ExternalId の SecureString のみ (describe-stack と同パターン)
 *   - DDB は deployments の Query (GSI1) + disruptions の PutItem (EXEC# 冪等) のみ
 *   - scheduler:CreateSchedule + iam:PassRole は revert scheduler role のみ
 * SaaS (cross-account) では SDK の SendCommand / Invoke / UpdateStack 権限は **本 Lambda の role には
 * 無い** (= 注入は assumed competitor 同意済 Admin role で行う)。 = blast radius を IAM で封じつつ、
 * 破壊操作は competitor の同意済 role に閉じる。
 *
 * #1710 Lite mode 例外: Lite (= same-account deploy) では AssumeRole 先の競技者アカウントが存在せず、
 * 注入は本 Lambda 自身の credentials で同一アカウントへ行う。 そのため ssm-run-command kind の注入
 * (SendCommand) を **同一アカウントの instance + 標準 shell document に限定**して付与する。 SaaS では
 * assumed Admin role 経由で注入するため本 grant は不使用 (= 同一アカウントの自テナント問題スタックに限定
 * された余剰権限で、 Lite の単一テナント運用ではブラスト半径は organizer 自身の account に閉じる)。
 *
 * revert は scheduler が本 Lambda 自身を `mode:"revert"` payload で呼び戻す one-shot (= EXEC# 冪等 name)。
 */
export class DisruptionExecutorLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: DisruptionExecutorLambdaProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // self-invoke (scheduler → executor) の ARN を循環なしで得るため functionName を固定し、 ARN を構築する。
    const functionName = `${stack.stackName}-disruption-executor`.slice(0, 64);
    const executorArn = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: functionName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // scheduler が executor を起動するために assume する role (= revert 予約の Target.RoleArn)。
    this.schedulerRole = new iam.Role(this, "RevertSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      inlinePolicies: {
        InvokeExecutor: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["lambda:InvokeFunction"],
              resources: [executorArn],
            }),
          ],
        }),
      },
    });

    this.fn = defineNodejsFunction(this, {
      functionName,
      // functionName は self-invoke ARN 構築のため固定だが、 log group 名は AUTO にする。
      // `/aws/lambda/<functionName>` を明示すると、 既に deploy 済の環境で Lambda が auto 作成した
      // 同名 log group と "already exists" 衝突を起こし deploy が失敗する。 Lambda は LoggingConfig
      // 経由でこの明示 group に書くので機能は不変、 旧 auto group は孤立するだけ (retention は Aspect)。
      entry: path.resolve(import.meta.dirname, "handlers/disruption-executor-handler/index.ts"),
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        // Issue #2441: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.deploymentsTable
          ? { DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName }
          : {}),
        // Issue #2442: 純 SQL backend では table 自体が無いので env も足さない。
        ...(props.disruptionsTable
          ? { DISRUPTIONS_TABLE_NAME: props.disruptionsTable.tableName }
          : {}),
        REVERT_SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
        EXECUTOR_FUNCTION_ARN: executorArn,
        // Issue #2442: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        ...(props.tursoDatabaseUrl ? { TURSO_DATABASE_URL: props.tursoDatabaseUrl } : {}),
        ...(props.tursoAuthTokenParameterName
          ? { TURSO_AUTH_TOKEN_PARAMETER_NAME: props.tursoAuthTokenParameterName }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      // disruptions catalog (action 込) を build 時 literal 置換 (env 4KB 回避、 fire と同 catalog)。
      bundlingDefine: {
        "process.env.BATTLE_PROBLEMS_DISRUPTIONS": JSON.stringify(
          JSON.stringify(props.problemsDisruptions ?? {}),
        ),
      },
    });

    // --- 最小 IAM ---
    const ssmArn = buildExternalIdParameterArnPattern(
      stack.region,
      stack.account,
      props.environmentName,
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [ssmArn],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringLike: { "kms:EncryptionContext:PARAMETER_ARN": ssmArn } },
      }),
    );
    // [Issue #2442] turso backend が Turso auth token を読むための SSM SecureString read
    // 権限。 未配線 (= dynamodb default) なら付与しない (`EventApiLambda` と同型)。
    if (props.tursoAuthTokenParameterName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter/${props.tursoAuthTokenParameterName.replace(/^\/+/, "")}`,
          ],
        }),
      );
    }
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/TenkaCloud-*"],
      }),
    );
    // #1710: Lite mode (= same-account) では AssumeRole 先が無く、 注入は本 Lambda の credentials で
    // 行う。 ssm-run-command kind の注入/復旧 (SendCommand) を同一アカウントの instance と標準 shell
    // document に限定して許可する。 SaaS では assumed Admin role で注入するため本 grant は不使用。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:SendCommand"],
        resources: [
          `arn:aws:ec2:*:${stack.account}:instance/*`,
          "arn:aws:ssm:*::document/AWS-RunShellScript",
          `arn:aws:ssm:*:${stack.account}:document/SSM-SessionManagerRunShell`,
        ],
      }),
    );
    // deployments: team deployment 解決は GSI1 Query のみ。Issue #2441: 純 SQL backend では
    // table 自体が無いので IAM も付与しない (repository seam が SQL executor 直結で処理する)。
    if (props.deploymentsTable) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:Query"],
          resources: [
            props.deploymentsTable.tableArn,
            `${props.deploymentsTable.tableArn}/index/GSI1`,
          ],
        }),
      );
    }
    // disruptions: EXEC# 冪等 claim は conditional PutItem のみ。Issue #2442: 純 SQL backend
    // では table 自体が無いので IAM も付与しない (repository seam が SQL executor 直結で処理する)。
    if (props.disruptionsTable) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:PutItem"],
          resources: [props.disruptionsTable.tableArn],
        }),
      );
    }
    // revert 予約 (scheduler) + その実行 role を渡す PassRole。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["scheduler:CreateSchedule"],
        resources: ["*"],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [this.schedulerRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      }),
    );

    // `*DisruptionFired` (= disruption-fire の publish) を拾って executor を起動する。
    new Rule(this, "FiredRule", {
      eventBus: props.eventBus,
      eventPattern: { source: ["tenkacloud.disruptions"] },
      targets: [new LambdaFunction(this.fn)],
    });
  }
}
