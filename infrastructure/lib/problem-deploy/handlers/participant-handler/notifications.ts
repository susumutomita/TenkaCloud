import type { NotificationItem, NotificationView } from "../shared/notification.js";
import type { ParticipantSharedResources } from "./shared.js";
import { queryTeamItems, resolveNotificationsRepository } from "./shared.js";

/**
 * `GET /portal/me/notifications` の response shape。
 */
export interface NotificationsResponse {
  readonly eventId: string;
  readonly items: readonly NotificationView[];
}

export type ListNotificationsOutcome =
  | { kind: "ok"; response: NotificationsResponse }
  | { kind: "unauthorized" }
  | { kind: "no_event" }
  | { kind: "invalid_limit" };

/** limit 既定値 / 上限 (API 設計)。*/
export const NOTIFICATIONS_DEFAULT_LIMIT = 100;
export const NOTIFICATIONS_MAX_LIMIT = 200;

/**
 * 自 team が紐づく event の通知一覧を時系列降順で返す。
 *
 * 認可: teamLoginKey で GSI2 を Query → team の deployments を取得。`eventId` は
 * 同 team の deployment 全行で一定 (event 1 件に紐づく構造) のため、
 * 任意の 1 行から拾えば十分。旧 jobId-based deployment (eventId 無し) は `no_event`。
 *
 * event 配下の通知を Notifications aggregate seam ({@link resolveNotificationsRepository})
 * から occurredAt 降順で 1 ページ取得する。`limit` で取得件数制限。現行 API に cursor は無い
 * ため `nextCursor` は捨てる (seam の cursor は将来のページング用で挙動不変)。
 *
 * 設計: tenantId / createdBy / 内部 PK/SK は **絶対に出さない** (NotificationView に
 * field が無いので構造的に漏れない)。
 */
export async function listNotifications(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  limitRaw: number = NOTIFICATIONS_DEFAULT_LIMIT,
): Promise<ListNotificationsOutcome> {
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > NOTIFICATIONS_MAX_LIMIT) {
    return { kind: "invalid_limit" };
  }

  const myItems = await queryTeamItems(shared, teamLoginKey);
  if (myItems.length === 0) return { kind: "unauthorized" };

  const eventId = myItems
    .map((i) => (typeof i.eventId === "string" ? i.eventId : undefined))
    .find((e): e is string => typeof e === "string" && e.length > 0);
  if (!eventId) return { kind: "no_event" };

  const notifications = await resolveNotificationsRepository(shared);
  const page = await notifications.listByEvent(eventId, { limit: limitRaw });

  const items = page.notifications
    .map(toView)
    .filter((v): v is NotificationView => v !== undefined);

  return { kind: "ok", response: { eventId, items } };
}

/** NotificationItem (DDB row) → NotificationView (公開 shape)。不正な行は undefined。 */
function toView(item: Partial<NotificationItem>): NotificationView | undefined {
  if (typeof item.notificationId !== "string") return undefined;
  if (typeof item.title !== "string") return undefined;
  if (typeof item.body !== "string") return undefined;
  if (item.severity !== "info" && item.severity !== "warning") return undefined;
  if (typeof item.occurredAt !== "string") return undefined;
  return {
    notificationId: item.notificationId,
    title: item.title,
    body: item.body,
    severity: item.severity,
    occurredAt: item.occurredAt,
  };
}
