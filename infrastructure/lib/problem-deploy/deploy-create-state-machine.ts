import { Duration } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Pass,
  Result,
  StateMachine,
  TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CodeBuildStartBuild,
  DynamoAttributeValue,
  DynamoUpdateItem,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { deploymentKey, stateEnteredTime } from "./state-machine-helpers.js";

export interface DeployCreateStateMachineProps {
  /** 実体の deploy を担う CodeBuild Project (= `scripts/deploy-battles.sh` を実行)。 */
  readonly codeBuildProject: Project;
  /**
   * CodeBuild 完了後に competitor account 側の CloudFormation stack を読む Lambda。
   * verified deployment は ExternalId 付き AssumeRole が必要なため、Step Functions の
   * platform-account CallAwsService ではなく Lambda に閉じ込める。
   */
  readonly describeStackFunction: IFunction;
  /**
   * Deployment 行を持つ DDB Table。CodeBuild 完了時に `status` を `PENDING` →
   * `COMPLETE` / `FAILED` に更新するために必要。
   */
  readonly deploymentsTable: ITable;
}

/**
 * 問題 deploy 起動を司る Step Functions State Machine。
 *
 * SBT `ScriptJob` 同型: `CodeBuildStartBuild` task (`RUN_JOB` integration = `.sync`)
 * で deploy script の完了を待ち、結果を DDB row に書き戻す。
 *
 * 入力 shape (event detail):
 *   {
 *     "jobId": "01HX...",
 *     "tenantId": "tenant-acme",
 *     "problemDir": "problems/challenges/hello-world",
 *     "teamSlug": "demo-team",
 *     "namePrefix": "tc-hello-world-demo-team",
 *     "region": "ap-northeast-1",
 *     "awsAccountId": "123456789012"
 *   }
 *
 * single-shot deploy のみ。Distributed Map による bulk 化と、
 * `cloudformation:describeStacks` による stackOutputs / stackId の取り込みは Phase 2。
 *
 * Issue #909 (#895 Phase 2.B): ADR-001 §2 は \"Create / Update / Delete の 3 state machine\"
 * を提示したが、 実装では **Create と Update を 1 state machine に collapse** している。
 * 理由: \`deploy-battles.sh\` が \`aws cloudformation deploy\` を使っており、 これが
 * CREATE / UPDATE を **idempotent** に扱う (= stack が無ければ Create、 あれば Update、
 * 差分無しは no-op で 0 終了)。 別 Update state machine を立てても操作上の差は無く、
 * 維持対象が増えるだけ。
 *
 * 残る semantics:
 *   - Delete: \`DeployDeleteStateMachine\` (= 別ファイル) で分離。 CFn API が異なるため
 *   - Create-or-Update: 本 state machine が両方を担当
 *
 * Update 専用 API (\`POST /deployments/update\`) も同様に不要。 同 deployment row への
 * 再 POST が事実上 update として動く (= deploy.ts handler 側で jobId 既存なら新 stack 名
 * 衝突を避ける仕組みが必要なら handler 側に追加するが、 state machine 設計とは独立)。
 */
export class DeployCreateStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployCreateStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    // PENDING (deploy.ts が初期 row を書く時の値) を IN_PROGRESS に倒す。CodeBuild の
    // RUN_JOB は同期で 5〜15 分待つので、この中間遷移が無いと operator UI は polling
    // しても PENDING のまま固定で「動いていない」ように見える (実際は deploy 進行中)。
    const markInProgress = new DynamoUpdateItem(this, "MarkInProgress", {
      table: props.deploymentsTable,
      key: deploymentKey(),
      updateExpression: "SET #status = :status, updatedAt = :updatedAt",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("IN_PROGRESS"),
        ":updatedAt": stateEnteredTime(),
      },
      resultPath: JsonPath.DISCARD,
    });

    // Phase 2.2 (Issue #459): AssumeRole metadata は 2 fields が両方あるときだけ
    // CodeBuild env に渡す。Step Functions の optional path 直接参照は field 欠落時に
    // States.Runtime で即死するため、Choice で cross-account / same-account を明示分岐する。
    //
    // Issue #895 Phase 2.A: ADR-001 §6 の stack tagging に必要な tenantId / jobId /
    // batchId を CodeBuild env に渡す。 deploy-battles.sh が `cloudformation deploy --tags`
    // に展開し、 operator が `cloudformation:ListStacks` + tag filter で batch を逆引き
    // できるようにする。 batchId は bulk 発火 (= 同一 event で N×M 個の deploy を撒く
    // ケース) で 1 batch を識別する。 単発 / authoring iteration では未指定 = jobId と
    // 同値 fallback で扱う (= deploy-battles.sh 側で fallback)。
    const startCodeBuildSameAccount = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
        DEPLOY_REGION: { value: JsonPath.stringAt("$.detail.region") },
        PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
        TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
        TENKACLOUD_TENANT_ID: { value: JsonPath.stringAt("$.detail.tenantId") },
        TENKACLOUD_JOB_ID: { value: JsonPath.stringAt("$.detail.jobId") },
      },
      resultPath: "$.codebuild",
    });

    const startCodeBuildCrossAccount = new CodeBuildStartBuild(
      this,
      "StartDeployCodeBuildCrossAccount",
      {
        project: props.codeBuildProject,
        integrationPattern: IntegrationPattern.RUN_JOB,
        environmentVariablesOverride: {
          BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
          TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
          DEPLOY_REGION: { value: JsonPath.stringAt("$.detail.region") },
          PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          TENKACLOUD_TENANT_ID: { value: JsonPath.stringAt("$.detail.tenantId") },
          TENKACLOUD_JOB_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          COMPETITOR_ROLE_ARN: {
            value: JsonPath.stringAt("$.detail.competitorRoleArn"),
          },
          EXTERNAL_ID_SSM_PARAMETER: {
            value: JsonPath.stringAt("$.detail.externalIdParameterName"),
          },
        },
        resultPath: "$.codebuild",
      },
    );

    const invalidAssumeRoleMetadata = new Pass(this, "InvalidAssumeRoleMetadata", {
      result: Result.fromObject({
        Cause:
          "competitorRoleArn and externalIdParameterName must be provided together for cross-account deploy",
      }),
      resultPath: "$.error",
    });

    const routeCreateInput = new Choice(this, "RouteCreateInput")
      .when(
        Condition.and(
          Condition.isPresent("$.detail.competitorRoleArn"),
          Condition.isPresent("$.detail.externalIdParameterName"),
        ),
        startCodeBuildCrossAccount,
      )
      .when(
        Condition.and(
          Condition.not(Condition.isPresent("$.detail.competitorRoleArn")),
          Condition.not(Condition.isPresent("$.detail.externalIdParameterName")),
        ),
        startCodeBuildSameAccount,
      )
      .otherwise(invalidAssumeRoleMetadata);

    // CodeBuild 完了後に CFn から Outputs と StackId を取得。verified deployment は
    // competitor account への AssumeRole が必要なので DescribeStackLambda に detail (= 元
    // EventBridge event の detail field) を渡す。
    // payloadResponseOnly=true により $.cfn は Lambda response (= DescribeStacks output)
    // そのものになり、既存 MarkSucceeded の JSONPath 契約を維持する。
    //
    // Issue #809: 旧コードは `payload: TaskInput.fromJsonPathAt("$")` を使っていたが、
    // CDK が optimized Lambda integration + `payloadResponseOnly: true` で
    // `Parameters: "$"` (= literal string) を生成し、 Lambda は literal `"$"` を event
    // として受け取って `event.detail.jobId` が undefined で fail していた。
    // `TaskInput.fromObject({...})` で明示的に object payload を組むと CDK は
    // `Parameters: { "detail.$": "$.detail" }` を生成し、 JSONPath が解決される。
    const describeStacks = new LambdaInvoke(this, "DescribeStack", {
      lambdaFunction: props.describeStackFunction,
      payload: TaskInput.fromObject({ detail: JsonPath.objectAt("$.detail") }),
      payloadResponseOnly: true,
      resultPath: "$.cfn",
    });

    const markSucceeded = this.buildMarkSucceeded(props.deploymentsTable);
    const markFailed = this.buildMarkFailed(props.deploymentsTable, "MarkFailed", true);
    const markFailedWithoutBuildId = this.buildMarkFailed(
      props.deploymentsTable,
      "MarkFailedWithoutBuildId",
      false,
    );
    const useStackStatusReasonAsFailureCause = new Pass(
      this,
      "UseStackStatusReasonAsFailureCause",
      {
        parameters: {
          "Cause.$": "$.cfn.Stacks[0].StackStatusReason",
        },
        resultPath: "$.error",
      },
    );
    useStackStatusReasonAsFailureCause.next(markFailed);
    const routeDescribedStackStatus = new Choice(this, "RouteDescribedStackStatus")
      .when(
        Condition.or(
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "ROLLBACK_COMPLETE"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "CREATE_FAILED"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "UPDATE_ROLLBACK_COMPLETE"),
        ),
        useStackStatusReasonAsFailureCause,
      )
      .otherwise(markSucceeded);
    const routeFailedDeployment = new Choice(this, "RouteFailedDeployment")
      .when(Condition.isPresent("$.codebuild.Build.Id"), markFailed)
      .otherwise(markFailedWithoutBuildId);

    // MarkInProgress / CodeBuild / DescribeStacks のいずれの失敗も MarkFailed (= status=FAILED)
    // に倒す。MarkInProgress は DDB throttle くらいでしか落ちないが落とし穴を残さないため
    // catch を付ける。DescribeStacks も稀な throttle / 競技者 account 側 Role の問題で
    // 落ちうる。その場合 stackOutputs 不在のまま FAILED にして operator が再試行する。
    // buildId は StartDeployCodeBuild が正常 output を返した後だけ存在するため、pre-CodeBuild
    // 失敗では従来通り buildId 無しで FAILED を書く。
    markInProgress.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    startCodeBuildSameAccount.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    startCodeBuildCrossAccount.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    describeStacks.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    describeStacks.next(routeDescribedStackStatus);
    startCodeBuildSameAccount.next(describeStacks);
    startCodeBuildCrossAccount.next(describeStacks);
    invalidAssumeRoleMetadata.next(markFailedWithoutBuildId);

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(markInProgress.next(routeCreateInput)),
      timeout: Duration.minutes(60),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });

    // DynamoUpdateItem task は CDK 側で grant しないので明示。
    props.deploymentsTable.grantWriteData(this.stateMachine);
  }

  private buildMarkSucceeded(table: ITable): DynamoUpdateItem {
    return new DynamoUpdateItem(this, "MarkSucceeded", {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs, buildId = :buildId",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("COMPLETE"),
        ":updatedAt": stateEnteredTime(),
        ":stackId": DynamoAttributeValue.fromString(JsonPath.stringAt("$.cfn.Stacks[0].StackId")),
        // CFn `Outputs: [{OutputKey, OutputValue, ...}]` の配列を JSON 文字列で格納。
        // 読み出し側 (cfn-status.ts:parseStackOutputs) は array / object どちらも解釈する。
        ":stackOutputs": DynamoAttributeValue.fromString(
          JsonPath.jsonToString(JsonPath.objectAt("$.cfn.Stacks[0].Outputs")),
        ),
        ":buildId": DynamoAttributeValue.fromString(JsonPath.stringAt("$.codebuild.Build.Id")),
      },
    });
  }

  private buildMarkFailed(table: ITable, id: string, persistBuildId: boolean): DynamoUpdateItem {
    return new DynamoUpdateItem(this, id, {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason" +
        (persistBuildId ? ", buildId = :buildId" : ""),
      expressionAttributeNames: {
        "#status": "status",
        "#failureReason": "failureReason",
      },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("FAILED"),
        ":updatedAt": stateEnteredTime(),
        // `$.error.Cause` は CodeBuild RUN_JOB の `States.TaskFailed` Cause (= build
        // 失敗 detail の JSON 文字列)。100 文字を超えるので JSON のまま格納する。
        ":failureReason": DynamoAttributeValue.fromString(JsonPath.stringAt("$.error.Cause")),
        ...(persistBuildId
          ? {
              ":buildId": DynamoAttributeValue.fromString(
                JsonPath.stringAt("$.codebuild.Build.Id"),
              ),
            }
          : {}),
      },
    });
  }
}
