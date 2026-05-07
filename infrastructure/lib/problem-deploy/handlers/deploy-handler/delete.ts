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
  | { kind: "race"; reason: "tenant_or_status_mismatch" }
  | { kind: "missing_required_fields"; fields: readonly string[] };

/**
 * 手動 teardown を要求する。status を DELETING に倒して `DeployDeleteRequested` を
 * EventBridge に publish するだけ (実 CFn DeleteStack は State Machine 経由で非同期実行)。
 * 詳細フローは ADR-004 を参照。
 *
 * publish 失敗時は status を FAILED に巻き戻す: DELETING のまま放置すると次の呼び出しが
 * `already_deleted` で no-op を返して CFn stack が orphan 化するため。
 *
 * `tenantId` mismatch は `not_found` を返してクロステナント漏洩を防ぐ。必須フィールド
 * (region / awsAccountId / stackName) の欠損は `missing_required_fields` で並行更新
 * (`race`) とは区別する (corruption 検出シグナル)。
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

  const missing: string[] = [];
  if (!region) missing.push("region");
  if (!awsAccountId) missing.push("awsAccountId");
  if (!stackName) missing.push("stackName");
  if (missing.length > 0) {
    return { kind: "missing_required_fields", fields: missing };
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
  try {
    await publishProblemEvent({
      client: shared.events,
      busName: shared.eventBusName,
      detailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
      jobId,
      detail,
    });
  } catch (err) {
    // publish 失敗時の compensation: status を FAILED に倒し failureReason を残す。
    // DELETING のまま放置すると、次の呼び出しが `already_deleted` で no-op を返し、
    // CFn stack が orphan 化する (= 削除できない状態に陥る) ため。
    // best-effort で、compensation 自体が失敗しても元の publish エラーを伝播する。
    try {
      await shared.ddb.send(
        new UpdateCommand({
          TableName: shared.tableName,
          Key: { PK: `DEPLOYMENT#${jobId}`, SK: "META" },
          UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
          ConditionExpression: "#s = :deleting",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":failed": "FAILED",
            ":deleting": "DELETING",
            ":updatedAt": new Date(nowMs).toISOString(),
            ":reason": "Failed to publish DeployDeleteRequested event",
          },
        }),
      );
    } catch {
      // best-effort: compensation 失敗は黙って捨て、元の publish エラーを表に出す
    }
    throw err;
  }

  return { kind: "accepted", previousStatus: status };
}
