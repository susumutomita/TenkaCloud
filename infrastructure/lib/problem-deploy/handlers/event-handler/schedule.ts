import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeploymentItem } from "../deploy-handler/types.js";
import type { EventSharedResources } from "./shared.js";
import type { EventItem } from "./types.js";

/**
 * `setEventSchedule` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `ok`: 更新後の startsAt + 影響を受けた deployment 数を返す
 */
export type SetEventScheduleOutcome =
  | { kind: "not_found" }
  | { kind: "ok"; startsAt: string; updatedDeployments: number };

/**
 * Event の `startsAt` を更新し、紐づく全 deployment 行に `eventStartsAt` を denormalize する。
 *
 * HealthCheckLambda は deployment 行の `eventStartsAt` を見て probe / 採点 gate するため、
 * Event 単独更新では足りない (event-handler Lambda は Deployments table に R/W 権限を持つので
 * CDK 改修不要)。
 *
 * `startsAt` は ISO8601 文字列。caller 側 (handler/index.ts) で zod validate 済を前提とする。
 *
 * tenant 跨ぎ参照防止: Event 行の tenantId が引数 `tenantId` と一致しない場合は `not_found`。
 */
export async function setEventSchedule(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  startsAt: string,
  nowMs: number,
): Promise<SetEventScheduleOutcome> {
  // Event の存在 + tenantId 確認のため UpdateItem の ConditionExpression で防御。
  // 同時に Deployments の対象行 (eventId 一致) を Query で集める。
  const now = new Date(nowMs).toISOString();

  let updatedEvent: Partial<EventItem> | undefined;
  try {
    const updateOut = await shared.ddb.send(
      new UpdateCommand({
        TableName: shared.eventsTableName,
        Key: { PK: `EVENT#${eventId}`, SK: "META" },
        UpdateExpression: "SET startsAt = :startsAt, updatedAt = :now",
        ConditionExpression: "tenantId = :tenantId",
        ExpressionAttributeValues: {
          ":startsAt": startsAt,
          ":now": now,
          ":tenantId": tenantId,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    updatedEvent = updateOut.Attributes as Partial<EventItem> | undefined;
  } catch (err) {
    // ConditionalCheckFailedException = 行不在 or tenant 不一致 → not_found
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      return { kind: "not_found" };
    }
    throw err;
  }
  if (!updatedEvent) return { kind: "not_found" };

  // 紐づく deployment 行を全部引いて eventStartsAt を伝播。GSI1 (TENANT#) で全件取得し
  // eventId フィルタ — 同 tenant 内 deployment <100 程度の運用想定で in-memory 処理可。
  const deploymentsOut = await shared.ddb.send(
    new QueryCommand({
      TableName: shared.deploymentsTableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
      ProjectionExpression: "PK, eventId",
    }),
  );
  const targets = (deploymentsOut.Items ?? [])
    .map((d) => d as Pick<DeploymentItem, "PK" | "eventId">)
    .filter((d) => d.eventId === eventId && typeof d.PK === "string");

  // Promise.all で並列 update。各 row は冪等な単一フィールド update (UpdateExpression)。
  await Promise.all(
    targets.map((d) =>
      shared.ddb.send(
        new UpdateCommand({
          TableName: shared.deploymentsTableName,
          Key: { PK: d.PK, SK: "META" },
          UpdateExpression: "SET eventStartsAt = :s, updatedAt = :now",
          ExpressionAttributeValues: { ":s": startsAt, ":now": now },
        }),
      ),
    ),
  );

  return { kind: "ok", startsAt, updatedDeployments: targets.length };
}
