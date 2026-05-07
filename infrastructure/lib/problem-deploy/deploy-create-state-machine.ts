import { Duration, Stack } from "aws-cdk-lib";
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

    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
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
    const markFailed = this.buildMarkFailed(props.deploymentsTable);

    // CodeBuild 失敗 / DescribeStacks 失敗、いずれも MarkFailed (= status=FAILED) に倒す。
    // DescribeStacks は基本失敗しないが、稀な throttle / 競技者 account 側の Roles で
    // 落ちうる。その場合 stackOutputs 不在のまま FAILED にして operator が再試行する。
    startCodeBuild.addCatch(markFailed, { resultPath: "$.error" });
    describeStacks.addCatch(markFailed, { resultPath: "$.error" });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(
        startCodeBuild.next(describeStacks).next(markSucceeded),
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
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs",
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
