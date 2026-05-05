import { Duration } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CodeBuildStartBuild,
  DynamoAttributeValue,
  DynamoUpdateItem,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

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
 * 問題 deploy 起動を司る Step Functions State Machine (MVP-1)。
 *
 * SBT `ScriptJob` 同型: EventBridge Rule から `DeployCreateRequested` event を受けて起動し、
 * `CodeBuildStartBuild` task (`RUN_JOB` integration pattern = `.sync`) で deploy script
 * の完了を待つ。完了後に DDB row の `status` を `COMPLETE` / `FAILED` に書き換える。
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
 * MVP-1 では deploy 1 件 (single-shot) を扱う。Phase 2 で Distributed Map にして
 * 複数 (problem × account) を bulk 処理に拡張する。CFn Outputs / stackId の取り込み
 * は Step Functions の `CallAwsService` (`cloudformation:describeStacks`) で別 PR で
 * 追加する (要 stackOutputs 整形 = array → object 変換)。
 */
export class DeployCreateStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployCreateStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    // CodeBuild を `.sync` で起動。完了まで待ち、失敗したら `MarkFailed` に分岐する。
    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
      },
      // CodeBuild の実行結果 ($) を resultPath に保持し、後続 task で `$.detail` を
      // 参照できるようにする (= 入力を上書きしない)。
      resultPath: "$.codebuild",
    });

    // Deployment 行を `status=COMPLETE` で書き換える。`stackOutputs` / `stackId` は
    // 別 PR で `cloudformation:describeStacks` を経由して埋める。
    const markSucceeded = this.markStatus({
      id: "MarkSucceeded",
      table: props.deploymentsTable,
      status: "COMPLETE",
    });

    // 失敗経路: `$.error.Cause` から原因を抜いて `failureReason` に格納し、
    // status=FAILED で書き換える。State Machine 自体は SUCCEEDED で抜ける (= deploy
    // が失敗したことは Step Functions レイヤーでは「終わった」扱い、本体結果は
    // DDB row で確認する)。
    const markFailed = this.markStatus({
      id: "MarkFailed",
      table: props.deploymentsTable,
      status: "FAILED",
      includeFailureReason: true,
    });

    startCodeBuild.addCatch(markFailed, { resultPath: "$.error" });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(startCodeBuild.next(markSucceeded)),
      timeout: Duration.minutes(60),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });

    // State Machine Role に DynamoUpdateItem 権限を付与 (DynamoUpdateItem task が
    // CDK 内部で grant しないので明示的に行う)。
    props.deploymentsTable.grantWriteData(this.stateMachine);
  }

  private markStatus(args: {
    id: string;
    table: ITable;
    status: "COMPLETE" | "FAILED";
    includeFailureReason?: boolean;
  }): DynamoUpdateItem {
    const expressionAttributeNames: Record<string, string> = { "#status": "status" };
    const expressionAttributeValues: Record<string, DynamoAttributeValue> = {
      ":status": DynamoAttributeValue.fromString(args.status),
      ":updatedAt": DynamoAttributeValue.fromString(JsonPath.stringAt("$$.State.EnteredTime")),
    };
    const setClauses = ["#status = :status", "updatedAt = :updatedAt"];

    if (args.includeFailureReason) {
      expressionAttributeNames["#failureReason"] = "failureReason";
      expressionAttributeValues[":failureReason"] = DynamoAttributeValue.fromString(
        // `$.error.Cause` は Step Functions が catch 時に注入する JSON 文字列。
        // CodeBuild RUN_JOB の場合 `States.TaskFailed` の Cause に build 失敗の
        // detail が入る。100 文字以内に収まらないことがあるので JSON 文字列のまま渡す。
        JsonPath.stringAt("$.error.Cause"),
      );
      setClauses.push("#failureReason = :failureReason");
    }

    return new DynamoUpdateItem(this, args.id, {
      table: args.table,
      key: {
        PK: DynamoAttributeValue.fromString(
          JsonPath.format("DEPLOYMENT#{}", JsonPath.stringAt("$.detail.jobId")),
        ),
        SK: DynamoAttributeValue.fromString("META"),
      },
      updateExpression: `SET ${setClauses.join(", ")}`,
      expressionAttributeNames,
      expressionAttributeValues,
      // ConditionExpression は付けない (= 同 jobId の race を許容、後勝ち)。
      // 失敗 path 後に成功 path が走ることはない (mutually exclusive な State Machine
      // 分岐) のでこのままで良い。
    });
  }
}
