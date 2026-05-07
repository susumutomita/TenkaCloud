import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";
import type { EventSharedResources } from "./shared.js";

export interface BulkTeardownResult {
  readonly eventId: string;
  readonly enqueued: number;
  readonly skipped: number;
}

export type BulkTeardownOutcome =
  | { kind: "ok"; result: BulkTeardownResult }
  | { kind: "not_found" };

const PUT_EVENTS_BATCH = 10;

/**
 * `DELETE /events/{eventId}` の実体。Event 配下の全 deployment 行 (eventId == 指定) を
 * GSI1 (TENANT) で引き、PENDING / IN_PROGRESS / COMPLETE / FAILED な行に対して
 * status=DELETING を倒し、`DeployDeleteRequested` を fan-out publish する。既存
 * DeployDelete State Machine が個別に CFn DeleteStack を実行する。
 *
 * `tenantId` mismatch / event 不在は `not_found`。既に DELETING / DELETED な行は
 * skipped に計上 (= 操作者の再実行に対して idempotent)。
 *
 * 失敗 semantics: status update に成功した行は publish されるべき。chunk 化された
 * publish が途中で失敗すると、status は DELETING のまま orphan 化する。caller は
 * 再呼び出しすると DELETING 行は skip され、未 publish 分のみ拾える (= 結果整合性)。
 */
export async function bulkTeardownEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<BulkTeardownOutcome> {
  // GSI1 (TENANT#<tenantId>) で全 deployment を取り、in-memory で eventId フィルタ。
  // 数百件規模を想定 (event が 25 teams × 30 problems = 750 行)。
  const out = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.deploymentsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
    }),
  );
  const all = (out.Items ?? []) as Partial<DeploymentItem>[];
  const targets = all.filter((i) => i.eventId === eventId);
  if (targets.length === 0) {
    // event が存在しないのか、まだ deploy してないのかを区別するため Events table を確認。
    const eventOut = await shared.ddb.send(
      new QueryCommand({
        TableName: shared.eventsTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
      }),
    );
    const exists = (eventOut.Items ?? []).some(
      (i) => (i as { eventId?: string }).eventId === eventId,
    );
    if (!exists) return { kind: "not_found" };
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  const updatedAt = new Date(nowMs).toISOString();
  const entries: PutEventsRequestEntry[] = [];
  let skipped = 0;

  for (const item of targets) {
    const status = item.status ?? "PENDING";
    if (status === "DELETING" || status === "DELETED") {
      skipped++;
      continue;
    }
    const jobId = String(item.jobId ?? "");
    const region = String(item.region ?? "");
    const awsAccountId = String(item.awsAccountId ?? "");
    const stackName = String(item.stackId ?? item.namePrefix ?? "");
    if (!jobId || !region || !awsAccountId || !stackName) {
      skipped++;
      continue;
    }

    try {
      await shared.ddb.send(
        new UpdateCommand({
          TableName: shared.deploymentsTableName,
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
        }),
      );
    } catch (err) {
      const code = (err as { name?: string })?.name ?? "";
      if (code === "ConditionalCheckFailedException") {
        // 並行 update / すでに DELETING に倒れた行は skip
        skipped++;
        continue;
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
    entries.push({
      EventBusName: shared.eventBusName,
      Source: EVENT_SOURCE,
      DetailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
      Detail: JSON.stringify(detail),
      Resources: [`tenkacloud:deployment:${jobId}`],
    });
  }

  for (let i = 0; i < entries.length; i += PUT_EVENTS_BATCH) {
    const chunk = entries.slice(i, i + PUT_EVENTS_BATCH);
    await shared.events.send(new PutEventsCommand({ Entries: chunk }));
  }

  return { kind: "ok", result: { eventId, enqueued: entries.length, skipped } };
}
