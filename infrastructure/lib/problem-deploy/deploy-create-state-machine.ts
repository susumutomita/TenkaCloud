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

    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
      },
      // 後続 task が `$.detail` を参照できるよう、CodeBuild 結果を sub-path に格納。
      resultPath: "$.codebuild",
    });

    const markSucceeded = this.buildMarkSucceeded(props.deploymentsTable);
    const markFailed = this.buildMarkFailed(props.deploymentsTable);

    startCodeBuild.addCatch(markFailed, { resultPath: "$.error" });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(startCodeBuild.next(markSucceeded)),
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
      updateExpression: "SET #status = :status, updatedAt = :updatedAt",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("COMPLETE"),
        ":updatedAt": stateEnteredTime(),
      },
    });
  }

  private buildMarkFailed(table: ITable): DynamoUpdateItem {
    return new DynamoUpdateItem(this, "MarkFailed", {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason",
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
      },
    });
  }
}

function deploymentKey(): { PK: DynamoAttributeValue; SK: DynamoAttributeValue } {
  return {
    PK: DynamoAttributeValue.fromString(
      JsonPath.format("DEPLOYMENT#{}", JsonPath.stringAt("$.detail.jobId")),
    ),
    SK: DynamoAttributeValue.fromString("META"),
  };
}

function stateEnteredTime(): DynamoAttributeValue {
  return DynamoAttributeValue.fromString(JsonPath.stringAt("$$.State.EnteredTime"));
}
