import { PutEventsCommand, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { resolveVerifiedCompetitorAccount } from "../shared/competitor-account-lookup.js";
import {
  type DeployDeleteRequestedDetail,
  EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
  EVENT_SOURCE,
} from "../shared/events.js";
import { type EventSharedResources, queryDeploymentsByEvent } from "./shared.js";
import type { EventItem } from "./types.js";

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
 * `DELETE /events/{eventId}` の実体。
 *
 * 1. Event 行を Get で確認 (= tenantId mismatch / 不在は not_found)
 * 2. Deployments を GSI1 で query → eventId フィルタ (Phase 3+ で eventId 専用 GSI 化を検討)
 * 3. 各行を `Promise.all` 並列で `status=DELETING` に conditional update
 * 4. update 成功分の DeployDeleteRequested を chunk 並列 publish
 *
 * 既に DELETING / DELETED な行 / 並行更新 race / 必須フィールド欠損は skipped に計上
 * (= 操作者の再実行に対して idempotent)。
 *
 * 失敗 semantics: publish chunk が失敗すると未 publish 分は status=DELETING のまま
 * orphan 化する。caller が再呼び出ししても DELETING 行は skip されるため、Phase 3 で
 * compensation pattern (FAILED 巻き戻し) を別途検討する。
 */
export async function bulkTeardownEvent(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  nowMs: number,
): Promise<BulkTeardownOutcome> {
  const eventOut = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
    }),
  );
  const event = eventOut.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return { kind: "not_found" };

  const targets = await queryDeploymentsByEvent(shared, tenantId, eventId);
  if (targets.length === 0) {
    return { kind: "ok", result: { eventId, enqueued: 0, skipped: 0 } };
  }

  const updatedAt = new Date(nowMs).toISOString();
  type UpdateOutcome = { entry: PutEventsRequestEntry } | { skip: true };

  // 各 deployment の status=DELETING update を Promise.all で並列発火 (750 件 × 50ms
  // = 37.5s の逐次は Lambda timeout に到達する)。各 update は独立で互いに依存しない。
  const outcomes = await Promise.all(
    targets.map(async (item): Promise<UpdateOutcome> => {
      const status = (item.status ?? "PENDING") as DeploymentStatus;
      if (status === "DELETING" || status === "DELETED") return { skip: true };

      const jobId = String(item.jobId ?? "");
      const region = String(item.region ?? "");
      const awsAccountId = String(item.awsAccountId ?? "");
      const stackName = String(item.stackId ?? item.namePrefix ?? "");
      if (!jobId || !region || !awsAccountId || !stackName) return { skip: true };

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
        if (code === "ConditionalCheckFailedException") return { skip: true };
        throw err;
      }

      const detail: DeployDeleteRequestedDetail = {
        jobId,
        correlationId: jobId,
        tenantId,
        stackName,
        region,
        awsAccountId,
      };
      const rowHasAssumeRoleMetadata =
        typeof item.competitorRoleArn === "string" &&
        item.competitorRoleArn.length > 0 &&
        typeof item.externalIdParameterName === "string" &&
        item.externalIdParameterName.length > 0;
      const verified = rowHasAssumeRoleMetadata
        ? undefined
        : await resolveVerifiedCompetitorAccount(
            {
              ddb: shared.ddb,
              competitorAccountsTableName: shared.competitorAccountsTableName,
              env: shared.env,
            },
            tenantId,
            awsAccountId,
          );
      detail.competitorRoleArn = rowHasAssumeRoleMetadata
        ? item.competitorRoleArn
        : verified?.competitorRoleArn;
      detail.externalIdParameterName = rowHasAssumeRoleMetadata
        ? item.externalIdParameterName
        : verified?.externalIdParameterName;
      return {
        entry: {
          EventBusName: shared.eventBusName,
          Source: EVENT_SOURCE,
          DetailType: EVENT_DETAIL_TYPE_DEPLOY_DELETE_REQUESTED,
          Detail: JSON.stringify(detail),
          Resources: [`tenkacloud:deployment:${jobId}`],
        },
      };
    }),
  );

  const entries: PutEventsRequestEntry[] = [];
  let skipped = 0;
  for (const o of outcomes) {
    if ("skip" in o) skipped++;
    else entries.push(o.entry);
  }

  // EventBridge PutEvents の chunk を Promise.all で並列発火。
  const putChunks: Promise<unknown>[] = [];
  for (let i = 0; i < entries.length; i += PUT_EVENTS_BATCH) {
    const chunk = entries.slice(i, i + PUT_EVENTS_BATCH);
    putChunks.push(shared.events.send(new PutEventsCommand({ Entries: chunk })));
  }

  // #557: Event status を TEARDOWN に倒す。bulk-deploy が DRAFT → DEPLOYING にする
  // 対称で、こちらは「終端化中」 marker。`updateEventScheduledStatus` の対と同じ pattern。
  // ConditionExpression で ARCHIVED は踏み越えない (= 一度 archive 済の event を逆走させない)。
  // CCF は既に ARCHIVED か行不在 → 触らないだけで成功扱い (handler は GetCommand で確認済)。
  // PutEvents と並列実行 (互いに依存なし)。
  const updateStatus = shared.ddb
    .send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET #status = :teardown, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId AND #status <> :archived",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":teardown": "TEARDOWN",
          ":archived": "ARCHIVED",
          ":tenantId": tenantId,
          ":now": updatedAt,
        },
      }),
    )
    .catch((err: unknown) => {
      if (err instanceof Error && err.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    });
  await Promise.all([...putChunks, updateStatus]);

  return { kind: "ok", result: { eventId, enqueued: entries.length, skipped } };
}
