/**
 * Notifications の既読管理 (ADR-006 D2)。
 *
 * 既読は **localStorage で competitor のブラウザに閉じ込める**: server side に read
 * endpoint を持たない (= API surface を最小化、tenant 跨ぎ問題を作らない)。
 * value は最後に画面で見た notification の `occurredAt` (ISO 8601)。
 *
 * 利用シナリオ:
 *   - TopNav: notifications.items.filter(n => n.occurredAt > lastSeen).length が未読数
 *   - /notifications page を開いたら markAllSeen(latestOccurredAt) で値を進める
 */

const STORAGE_KEY = "TenkaCloud.participant.lastSeenNotificationAt";

/** 最終既読時刻 (ISO 8601) を localStorage から読む。未設定 / private window 等は null。 */
export function loadLastSeenAt(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 最終既読時刻を保存する。`occurredAt` が現在の格納値より過去なら何もしない (= 巻き戻し防止)。
 * private window / quota 超過などで write 失敗しても throw しない (graceful degradation)。
 */
export function saveLastSeenAt(occurredAt: string): void {
  if (typeof occurredAt !== "string" || occurredAt.length === 0) return;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current && current >= occurredAt) return;
    localStorage.setItem(STORAGE_KEY, occurredAt);
  } catch {
    // ignore
  }
}

/**
 * 与えられた items から「未読件数」を計算する (= occurredAt > lastSeen)。
 * `lastSeen` が null なら全件未読扱い。1 partition 内 N 件想定で O(N) 線形 scan。
 */
export function countUnread<T extends { occurredAt: string }>(
  items: readonly T[],
  lastSeen: string | null,
): number {
  if (lastSeen === null) return items.length;
  let count = 0;
  for (const i of items) if (i.occurredAt > lastSeen) count++;
  return count;
}
