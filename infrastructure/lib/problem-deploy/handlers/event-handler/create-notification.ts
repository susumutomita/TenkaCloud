import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type { NotificationCreateRequest, NotificationItem } from "../shared/notification.js";
import type { EventSharedResources } from "./shared.js";
import type { EventItem } from "./types.js";

/**
 * `createNotification` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `ok`       : 書き込み完了。notificationId / occurredAt を返す。
 */
export type CreateNotificationOutcome =
  | { kind: "not_found" }
  | { kind: "ok"; notificationId: string; occurredAt: string };

/**
 * Event に紐づく 1 通知行を Events table に PutItem する (ADR-006)。
 *
 * `severity` 既定値は `info`。`expiresAt` は親 event 行と同値 (epoch seconds、TTL 同期)。
 * `createdBy` は operator の Cognito sub (tenant API GW + JWT authorizer から渡る `sub` claim)。
 *
 * 失敗セマンティクス:
 *   - tenant 不一致 / event 不在 → `not_found`
 *   - DDB 書き込み失敗 → throw (caller が 500 にする)
 *
 * 1 partition (= 1 event) に N 通知が並ぶが、SK = NOTIFICATION#<isoTs>#<ulid> なので
 * 同 ms の race も ulid suffix で衝突回避できる (= 採点 event 行と同じ流儀)。
 */
export async function createNotification(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdBy: string,
  req: NotificationCreateRequest,
  nowMs: number = Date.now(),
): Promise<CreateNotificationOutcome> {
  const probe = await shared.ddb.send(
    new GetCommand({
      TableName: shared.eventsTableName,
      Key: { PK: `EVENT#${eventId}`, SK: "META" },
    }),
  );
  const event = probe.Item as Partial<EventItem> | undefined;
  if (!event || event.tenantId !== tenantId) return { kind: "not_found" };

  const notificationId = ulid();
  const occurredAt = new Date(nowMs).toISOString();
  const item: NotificationItem = {
    PK: `EVENT#${eventId}`,
    SK: `NOTIFICATION#${occurredAt}#${notificationId}`,
    notificationId,
    tenantId,
    eventId,
    title: req.title,
    body: req.body,
    severity: req.severity ?? "info",
    createdBy,
    occurredAt,
    expiresAt: Number(event.expiresAt ?? 0),
  };

  await shared.ddb.send(new PutCommand({ TableName: shared.eventsTableName, Item: item }));
  return { kind: "ok", notificationId, occurredAt };
}
