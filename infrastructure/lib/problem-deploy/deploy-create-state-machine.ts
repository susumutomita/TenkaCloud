import { Duration, Stack } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CallAwsService,
  CodeBuildStartBuild,
  DynamoAttributeValue,
  DynamoUpdateItem,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { deploymentKey, stateEnteredTime } from "./state-machine-helpers";

export interface DeployCreateStateMachineProps {
  /** 実体の deploy を担う CodeBuild Project (= `scripts/deploy-battles.sh` を実行)。 */
  readonly codeBuildProject: Project;
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

    // Phase 2.2 (Issue #459): `$.detail.competitorRoleArn` / `$.detail.externalIdParameterName`
    // を CodeBuild env に渡す。`deploy-battles.sh` 内で `COMPETITOR_ROLE_ARN` が空でなければ
    // AssumeRole + ExternalId 経路に倒し、空なら same-account fallback (dev / 未 verify) を残す。
    // Step Functions の `States.Format` / 直接 path 参照は path が `undefined` だと fail する
    // (= optional field を入れるのが難しい)。bulk-deploy / startDeployment は verified=true
    // のときのみ field を埋めているため、verified-only 経路では必ず存在する。
    // 未 verified だった場合は publish そのものが起きないので path 参照しても to-end は安全。
    // ただ後方互換 (= 旧 event detail に competitorRoleArn 無し) を保つため、CodeBuild env は
    // 任意 path 経由で参照する。
    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
        // Phase 2.2: AssumeRole metadata。verified=true 行のみ埋められるので、unverified 経路
        // で State Machine が起動することは無い (= bulk-deploy / startDeployment が事前に gate)。
        // `States.Format` を使って `null` 安全 (= 値が無いなら空文字)。
        COMPETITOR_ROLE_ARN: {
          value: JsonPath.format("{}", JsonPath.stringAt("$.detail.competitorRoleArn")),
        },
        EXTERNAL_ID_SSM_PARAMETER: {
          value: JsonPath.format("{}", JsonPath.stringAt("$.detail.externalIdParameterName")),
        },
        DEPLOY_REGION: { value: JsonPath.stringAt("$.detail.region") },
        PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
      },
      resultPath: "$.codebuild",
    });

    // CodeBuild 完了後に CFn から Outputs と StackId を取得。Outputs は
    // `[{OutputKey, OutputValue, ...}]` の配列形で返るので、stackOutputs に JSON
    // 文字列として格納し、portal 側 (cfn-status.ts) が array / object 両方を解釈する。
    const describeStacks = new CallAwsService(this, "DescribeStack", {
      service: "cloudformation",
      action: "describeStacks",
      parameters: { StackName: JsonPath.stringAt("$.detail.namePrefix") },
      iamResources: [
        Stack.of(this).formatArn({
          service: "cloudformation",
          resource: "stack",
          resourceName: "*",
        }),
      ],
      iamAction: "cloudformation:DescribeStacks",
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
    startCodeBuild.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    describeStacks.addCatch(routeFailedDeployment, { resultPath: "$.error" });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(
        markInProgress.next(startCodeBuild).next(describeStacks).next(routeDescribedStackStatus),
      ),
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
