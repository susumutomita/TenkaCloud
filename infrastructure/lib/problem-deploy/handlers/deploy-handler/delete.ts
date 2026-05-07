import { GetCommand, UpdateCommand, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  publishProblemEvent,
} from "../shared/events.js";
import type { DeploySharedResources } from "./deploy.js";
import type { DeploymentItem, DeploymentStatus } from "./types.js";

export type TeardownOutcome =
  | { kind: "accepted"; previousStatus: DeploymentStatus }
  | { kind: "not_found" }
  | { kind: "already_deleted" }
  | { kind: "race"; reason: "tenant_or_status_mismatch" };

/**
 * 手動 teardown を要求する。Deploy 経路 (Lambda → EventBridge → State Machine →
 * CodeBuild → CFn CreateStack) と対称な削除経路 (Lambda → EventBridge →
 * `DeployDelete` State Machine → CodeBuild → CFn DeleteStack) を発火する。
 *
 * 1. 行を Get → tenantId 一致と status を確認 (race / not_found 防止)
 * 2. status を `DELETING` に conditional update (race 防止 + UI に即時反映)
 * 3. EventBridge bus に `DeployDeleteRequested` を publish
 *    → `DeployDelete` Rule が State Machine を起動 → CodeBuild が delete-battles.sh
 *      で `aws cloudformation delete-stack` を実行し、State Machine が完了で DDB を
 *      `DELETED` に更新する (失敗時は `FAILED` + failureReason)
 *
 * 既に `DELETING` / `DELETED` の行は no-op で `already_deleted` を返す。
 * クロステナント漏洩防止のため `tenantId` mismatch は `not_found` 扱い。
 */
export async function requestTeardown(
  shared: DeploySharedResources,
  tenantId: string,
  jobId: string,
  nowMs: number,
): Promise<TeardownOutcome> {
  const got = await shared.ddb.send(
    new GetCommand({
      TableName: shared.tableName,
      Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    }),
  );
  const item = got.Item as Partial<DeploymentItem> | undefined;
  if (!item) return { kind: "not_found" };
  if (item.tenantId !== tenantId) return { kind: "not_found" };
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  if (status === "DELETING" || status === "DELETED") return { kind: "already_deleted" };

  const region = String(item.region ?? "");
  const awsAccountId = String(item.awsAccountId ?? "");
  // CFn StackName は namePrefix で十分 (StackId は不要、State Machine 側で region 指定して
  // delete-stack するときも namePrefix で identify できる)。stackId が無い場合 (PENDING で
  // 削除した場合) でも namePrefix は deploy 時に必ず確定している。
  const stackName = String(item.stackId ?? item.namePrefix ?? "");

  if (!region || !awsAccountId || !stackName) {
    return { kind: "race", reason: "tenant_or_status_mismatch" };
  }

  const updatedAt = new Date(nowMs).toISOString();
  const update: UpdateCommandInput = {
    TableName: shared.tableName,
    Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
    UpdateExpression: "SET #s = :deleting, updatedAt = :updatedAt",
    ConditionExpression: "tenantId = :tenantId AND #s IN (:p, :i, :c, :f)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":deleting": "DELETING",
      ":updatedAt": updatedAt,
      ":tenantId": tenantId,
      ":p": "PENDING",
      ":i": "IN_PROGRESS",
      ":c": "COMPLETE",
      ":f": "FAILED",
    },
  };
  try {
    await shared.ddb.send(new UpdateCommand(update));
  } catch (err) {
    const code = (err as { name?: string })?.name ?? "";
    if (code === "ConditionalCheckFailedException") {
      return { kind: "race", reason: "tenant_or_status_mismatch" };
    }
    throw err;
  }

  const detail: DeployDeleteRequestedDetail = {
    jobId,
    tenantId,
    stackName,
    region,
    awsAccountId,
  };
  await publishProblemEvent({
    client: shared.events,
    busName: shared.eventBusName,
    detailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
    jobId,
    detail,
  });

  return { kind: "accepted", previousStatus: status };
}
