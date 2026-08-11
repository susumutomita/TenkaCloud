import { portalFetch } from "./fetch";
import type { NotificationsResponse } from "./types";

/**
 * Notifications API: 運営 → 競技者 への通知の polling endpoint。
 *
 * `GET /portal/me/notifications?limit=` を `Authorization: Bearer <teamLoginKey>` で呼ぶ。
 * occurredAt 降順で最大 200 件。`limit` 未指定なら backend 側 default (100)。
 *
 * 旧 jobId-based deployment で eventId が無い場合は 404 (no_event) → `undefined`。
 * 新 deployment では空でも `{ items: [] }` が返るので `null` ではなく `undefined` で no-event と区別できる。
 */
export async function getNotifications(
  apiBaseUrl: string,
  teamLoginKey: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<NotificationsResponse | undefined> {
  const query: Record<string, string> = {};
  if (limit !== undefined) query.limit = String(limit);
  return await portalFetch<NotificationsResponse>(
    apiBaseUrl,
    "portal/me/notifications",
    teamLoginKey,
    { query, throwOn400: true, returnUndefinedOn404: true, signal },
  );
}
