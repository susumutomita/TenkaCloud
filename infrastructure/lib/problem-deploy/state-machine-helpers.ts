import { JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import { DynamoAttributeValue } from "aws-cdk-lib/aws-stepfunctions-tasks";

/**
 * Deploy 系 State Machine の DynamoUpdateItem task が共有する DDB Key 構築ヘルパー。
 * `DeployCreateStateMachine` と `DeployDeleteStateMachine` が同じ Deployments テーブル
 * を `EVENT detail.jobId` 由来の合成 PK で更新するため、両者から再利用する。
 */
export function deploymentKey(): { PK: DynamoAttributeValue; SK: DynamoAttributeValue } {
  return {
    PK: DynamoAttributeValue.fromString(
      JsonPath.format("DEPLOYMENT#{}", JsonPath.stringAt("$.detail.jobId")),
    ),
    SK: DynamoAttributeValue.fromString("META"),
  };
}

/**
 * 現 State 進入時刻 (`$$.State.EnteredTime`) を `updatedAt` ISO8601 として書き戻すための
 * `DynamoAttributeValue`。MarkSucceeded / MarkFailed / MarkDeleted で共通利用。
 */
export function stateEnteredTime(): DynamoAttributeValue {
  return DynamoAttributeValue.fromString(JsonPath.stringAt("$$.State.EnteredTime"));
}
