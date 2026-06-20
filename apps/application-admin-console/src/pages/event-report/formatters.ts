/**
 * Pure display formatters for the Event Report page (`/events/:eventId/report`).
 *
 * page render と HTML / Markdown exporter の双方が同じ schedule / 日付表記を使うため、
 * React 非依存の pure function として切り出す (= 表記ポリシーを 1 箇所に閉じる)。
 *   - `formatDate`: ISO 文字列を `YYYY-MM-DD HH:MM UTC` に整形。 invalid / 空は em dash。
 *   - `formatScheduleRange`: event の開始 — 終了を 1 行にまとめる。
 */

import type { EventDetail } from "../../api/events-client";

export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return `${new Date(ts).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function formatScheduleRange(detail: EventDetail): string {
  const startsAt = formatDate(detail.startsAt);
  const endsAt = formatDate(detail.endsAt);
  return `${startsAt} — ${endsAt}`;
}
