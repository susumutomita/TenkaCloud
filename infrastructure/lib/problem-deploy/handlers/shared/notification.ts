import { z } from "zod";

/**
 * 運営 → 競技者 Notification の DDB 行 shape (ADR-006)。
 *
 *   PK = `EVENT#<eventId>` (= 既存 Events partition と同居)
 *   SK = `NOTIFICATION#<occurredAt>#<ulid>` (時系列降順 sort + 衝突防止)
 *
 * 既存 META 行を巻き込まないので Event detail / list の Query には影響しない
 * (sparse な追加行)。TTL は親 event の `expiresAt` を継承し、event archive 後も
 * TTL までは残す (= 競技者の振り返り猶予、ADR-006 D5)。
 */
export interface NotificationItem {
  PK: string;
  SK: string;

  notificationId: string;
  tenantId: string;
  eventId: string;
  title: string;
  body: string;
  severity: "info" | "warning";
  /** 監査用に operator の Cognito sub を残す。UI には出さない。 */
  createdBy: string;
  occurredAt: string;
  /** DDB TTL。event 行の `expiresAt` と同値 (epoch seconds)。 */
  expiresAt: number;
}

/**
 * `POST /events/:eventId/notifications` 受信 body (ADR-006 API 設計)。
 *
 * - `title` 1〜120 chars
 * - `body`  1〜2000 chars
 * - `severity` optional、default `info`
 */
export const NotificationCreateRequestSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  severity: z.enum(["info", "warning"]).optional(),
});
export type NotificationCreateRequest = z.infer<typeof NotificationCreateRequestSchema>;

/**
 * 競技者向けに公開する Notification 1 行 (内部 PK/SK / tenantId / createdBy 等は出さない)。
 */
export interface NotificationView {
  readonly notificationId: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "warning";
  readonly occurredAt: string;
}
