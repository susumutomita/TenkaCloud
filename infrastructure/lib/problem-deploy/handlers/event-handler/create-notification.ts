import { ulid } from "ulid";
import type { NotificationRecord } from "../../control-data/notifications-repository.js";
import type { NotificationCreateRequest } from "../shared/notification.js";
import { type EventSharedResources, resolveEventRepositories } from "./shared.js";

/**
 * `createNotification` の結果。
 * - `not_found`: tenant 不一致 / event 不在 → 404 相当
 * - `ok`       : 書き込み完了。notificationId / occurredAt を返す。
 */
export type CreateNotificationOutcome =
  | { kind: "not_found" }
  | { kind: "ok"; notificationId: string; occurredAt: string };

/**
 * Event に紐づく 1 通知を Notifications aggregate へ追記する。
 *
 * `severity` 既定値は `info`。`expiresAt` は親 event 行と同値 (epoch seconds、TTL 同期)。
 * `createdBy` は operator の Cognito sub (tenant API GW + JWT authorizer から渡る `sub` claim)。
 *
 * 失敗セマンティクス:
 *   - tenant 不一致 / event 不在 → `not_found`
 *   - 書き込み失敗 → throw (caller が 500 にする)
 *
 * [#2439] 物理行 (DynamoDB backend では `PK=EVENT#<eventId>` /
 * SK に時系列降順ソートキー) の導出は {@link NotificationsRepository} seam の実装詳細。 caller は
 * PK/SK を持たない {@link NotificationRecord} を渡すだけ。 default backend では従来と byte 互換の
 * PutItem が飛ぶ。 同 ms の race も notificationId (ulid) suffix で衝突回避できる。
 */
export async function createNotification(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  createdBy: string,
  req: NotificationCreateRequest,
  nowMs: number = Date.now(),
): Promise<CreateNotificationOutcome> {
  // events / notifications 両 aggregate を 1 回だけ resolve して使い回す。
  const repositories = await resolveEventRepositories(shared);
  // getEvent は tenant 不一致 / event 不在をどちらも undefined に畳む
  // (= 従来の `!event || event.tenantId !== tenantId` を repository 内へ移設)。
  const event = await repositories.events.getEvent(tenantId, eventId);
  if (!event) return { kind: "not_found" };

  const notificationId = ulid();
  const occurredAt = new Date(nowMs).toISOString();
  const record: NotificationRecord = {
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

  await repositories.notifications.append(record);
  return { kind: "ok", notificationId, occurredAt };
}
