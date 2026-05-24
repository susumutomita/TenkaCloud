import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventSharedResources } from "../shared.js";
import { type PlanEntry, type PublishFailure, TRANSACT_WRITE_BATCH } from "./types.js";

/**
 * Plan entries を DDB TransactWrite で chunk 単位に書き込む。 retry/forceRedeploy 経路では
 * 1 entry あたり Put + Delete の 2 ops、 通常経路は Put のみ。 chunk size は 25 ops 上限から
 * 逆算する。 Put は `attribute_not_exists(PK)` で同 jobId 重複を防ぐ。
 */
export async function writeBulkDeployPlan(
  shared: EventSharedResources,
  tenantId: string,
  plan: readonly PlanEntry[],
  replacesExisting: boolean,
): Promise<void> {
  const opsPerEntry = replacesExisting ? 2 : 1;
  const planPerChunk = Math.floor(TRANSACT_WRITE_BATCH / opsPerEntry);
  const writes: Promise<unknown>[] = [];
  for (let index = 0; index < plan.length; index += planPerChunk) {
    const transactItems = buildTransactItems(
      shared,
      tenantId,
      plan.slice(index, index + planPerChunk),
    );
    writes.push(shared.ddb.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }
  await Promise.all(writes);
}

function buildTransactItems(
  shared: EventSharedResources,
  tenantId: string,
  plan: readonly PlanEntry[],
): TransactWriteCommandInput["TransactItems"] {
  const items: TransactWriteCommandInput["TransactItems"] = [];
  for (const entry of plan) {
    items.push({
      Put: {
        TableName: shared.deploymentsTableName,
        Item: entry.item,
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
    if (entry.replacesJobId) {
      items.push({
        Delete: {
          TableName: shared.deploymentsTableName,
          Key: { PK: `DEPLOYMENT#${entry.replacesJobId}`, SK: "META" },
          ConditionExpression: "tenantId = :tenantId",
          ExpressionAttributeValues: { ":tenantId": tenantId },
        },
      });
    }
  }
  return items;
}

/**
 * Event の status を DEPLOYING へ前進させる。 DRAFT / READY / DEPLOYING からのみ許可
 * (= ACTIVE / COMPLETE 等の後続状態を巻き戻さない)。 ConditionalCheckFailed は no-op。
 */
export async function markBulkEventDeploying(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdAt: string,
): Promise<void> {
  try {
    await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET #status = :deploying, updatedAt = :now",
        ConditionExpression:
          "tenantId = :tenantId AND (#status = :draft OR #status = :ready OR #status = :deploying)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deploying": "DEPLOYING",
          ":draft": "DRAFT",
          ":ready": "READY",
          ":now": createdAt,
          ":tenantId": tenantId,
        },
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
    throw err;
  }
}

/**
 * Publish 失敗 deployment を FAILED に倒す。 PENDING からのみ遷移 (= 別経路で進んだ行を
 * 巻き戻さない)。 ConditionalCheckFailed は no-op (= 既に他経路で更新済み)。
 */
export async function markPublishFailuresFailed(
  shared: EventSharedResources,
  tenantId: string,
  failures: readonly PublishFailure[],
  updatedAt: string,
): Promise<void> {
  await Promise.all(
    failures.map(async (failure) => {
      try {
        await shared.ddb.send(
          new UpdateCommand({
            TableName: shared.deploymentsTableName,
            Key: { PK: `DEPLOYMENT#${failure.jobId}`, SK: "META" },
            UpdateExpression: "SET #s = :failed, updatedAt = :updatedAt, failureReason = :reason",
            ConditionExpression: "tenantId = :tenantId AND #s = :pending",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":failed": "FAILED",
              ":pending": "PENDING",
              ":tenantId": tenantId,
              ":updatedAt": updatedAt,
              ":reason": `Failed to publish DeployCreateRequested event: ${failure.reason}`,
            },
          }),
        );
      } catch (err) {
        if (!(err instanceof Error) || err.name !== "ConditionalCheckFailedException") {
          throw err;
        }
      }
    }),
  );
}
