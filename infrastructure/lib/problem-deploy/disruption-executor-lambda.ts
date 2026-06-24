import * as path from "node:path";
import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";
import { buildExternalIdParameterArnPattern } from "./handlers/shared/external-id-store.js";

export interface DisruptionExecutorLambdaProps {
  readonly environmentName: string;
  /** disruption-fire が `*DisruptionFired` を publish する EventBus。 本 Lambda がその rule の target。 */
  readonly eventBus: IEventBus;
  /** team deployment 解決 (GSI1 Query) 用。 */
  readonly deploymentsTable: ITable;
  /** EXEC# 冪等行 (conditional Put) 用。 fire の REQUEST#/AUDIT# と同居。 */
  readonly disruptionsTable: ITable;
  /** `{ [problemId]: ProblemDisruptionEntry[] }` (action 込)。 build 時 literal 置換で env 4KB を回避。 */
  readonly problemsDisruptions?: Readonly<Record<string, unknown>>;
}

/**
 * [ADR-031 / Issue #1419] cross-account disruption executor Lambda (Phase B)。
 *
 * EventBridge `tenantcloud.disruptions` source の `*DisruptionFired` を拾い、 該当 team deployment へ
 * AssumeRole して実障害を注入し、 ADR-029 INV-2 のため revert を aws-scheduler に予約する。 注入の破壊力は
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

    this.fn = new NodejsFunction(this, "Function", {
      functionName,
      // functionName を固定しているため、 auto-created `/aws/lambda/<functionName>` log group と
      // 衝突しないよう明示 LogGroup も同名で作る (= retention は LogGroupRetention Aspect が一括設定)。
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        logGroupName: `/aws/lambda/${functionName}`,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/disruption-executor-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        DISRUPTIONS_TABLE_NAME: props.disruptionsTable.tableName,
        REVERT_SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
        EXECUTOR_FUNCTION_ARN: executorArn,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
        // disruptions catalog (action 込) を build 時 literal 置換 (env 4KB 回避、 fire と同 catalog)。
        define: {
          "process.env.BATTLE_PROBLEMS_DISRUPTIONS": JSON.stringify(
            JSON.stringify(props.problemsDisruptions ?? {}),
          ),
        },
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
    // deployments: team deployment 解決は GSI1 Query のみ。
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
    // disruptions: EXEC# 冪等 claim は conditional PutItem のみ。
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [props.disruptionsTable.tableArn],
      }),
    );
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
