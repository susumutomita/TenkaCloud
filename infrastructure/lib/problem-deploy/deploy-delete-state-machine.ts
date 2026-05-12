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
import { deploymentKey, stateEnteredTime } from "./state-machine-helpers";

export interface DeployDeleteStateMachineProps {
  /**
   * 実体の delete を担う CodeBuild Project (= `scripts/delete-battles.sh` を実行)。
   * `DeployCreateStateMachine` と同じ Project を共用する想定 (`OPERATION` env で
   * create / delete を分岐)。
   */
  readonly codeBuildProject: Project;
  /**
   * Deployment 行を持つ DDB Table。CodeBuild 完了時に `status` を `DELETING` →
   * `DELETED` / `FAILED` に更新するために必要。
   */
  readonly deploymentsTable: ITable;
}

/**
 * 問題 stack の削除を司る Step Functions State Machine。`DeployCreateStateMachine`
 * と対称な構造で、CodeBuildStartBuild `.sync` で delete script の完了を待ち、結果を
 * DDB row に書き戻す (status: `DELETING` → `DELETED` / `FAILED`)。
 *
 * 入力 shape (event detail):
 *   {
 *     "jobId": "01HX...",
 *     "tenantId": "tenant-acme",
 *     "stackName": "tc-hello-world-demo-team",   // または StackId (ARN)
 *     "region": "ap-northeast-1",
 *     "awsAccountId": "123456789012"
 *   }
 *
 * MVP-1 は same-account のみ。Phase 2 で cross-account になったら CodeBuild Role に
 * `sts:AssumeRole` を足し、delete-battles.sh で AssumeRole する形に拡張する。
 */
export class DeployDeleteStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployDeleteStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeleteCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        OPERATION: { value: "delete" },
        DELETE_STACK_NAME: { value: JsonPath.stringAt("$.detail.stackName") },
        DELETE_REGION: { value: JsonPath.stringAt("$.detail.region") },
        // Phase 2.2 (Issue #459): cross-account delete でも AssumeRole metadata を渡す。
        // detail に値が無いケース (旧 deployment 行) は `States.Format` で空文字に倒れる。
        COMPETITOR_ROLE_ARN: {
          value: JsonPath.format("{}", JsonPath.stringAt("$.detail.competitorRoleArn")),
        },
        EXTERNAL_ID_SSM_PARAMETER: {
          value: JsonPath.format("{}", JsonPath.stringAt("$.detail.externalIdParameterName")),
        },
      },
      resultPath: "$.codebuild",
    });

    const markDeleted = this.buildMarkDeleted(props.deploymentsTable);
    const markFailed = this.buildMarkFailed(props.deploymentsTable);

    startCodeBuild.addCatch(markFailed, { resultPath: "$.error" });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(startCodeBuild.next(markDeleted)),
      timeout: Duration.minutes(60),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });

    props.deploymentsTable.grantWriteData(this.stateMachine);
  }

  private buildMarkDeleted(table: ITable): DynamoUpdateItem {
    return new DynamoUpdateItem(this, "MarkDeleted", {
      table,
      key: deploymentKey(),
      // GSI2PK / GSI2SK を REMOVE して participant portal の lookup index から sparse 除外する。
      // expiresAt は TTL 用に十分小さい値で残し、DDB 側でも自動掃除させる。
      updateExpression: "SET #status = :status, updatedAt = :updatedAt REMOVE GSI2PK, GSI2SK",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("DELETED"),
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
        ":failureReason": DynamoAttributeValue.fromString(JsonPath.stringAt("$.error.Cause")),
      },
    });
  }
}
