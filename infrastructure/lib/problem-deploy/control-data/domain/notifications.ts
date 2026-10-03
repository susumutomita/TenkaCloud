/**
 * [Issue #2527 Slice 1] Notifications aggregate — domain record and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/**
 * [#2439 / Phase A4] Notifications aggregate の domain shape。 SK 導出
 * (`NOTIFICATION#<occurredAt>#<notificationId>`) は DynamoDB backend の実装詳細。
 * [Issue #2527 Slice 1 step 2] Source of truth; the physical row
 * (`handlers/shared/notification.ts`'s `NotificationItem`) adds PK/SK.
 */
export type NotificationRecord = {
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
};

/** [#2439] 1 ページ分の通知(EventsPage の鏡像)。 nextCursor は opaque・backend 固有。 */
export interface NotificationsPage {
  readonly notifications: readonly NotificationRecord[];
  readonly nextCursor?: string;
}

export interface NotificationsRepository {
  /**
   * 1 通知を追記する。 `expiresAt` は親 event 行と同値(TTL 同期)を caller が保証。
   * DDB は Put(同キー再送は上書き)、 SQL は upsert — 冪等性 parity。
   */
  append(record: NotificationRecord): Promise<void>;
  /**
   * event 配下の通知を occurredAt 降順で 1 ページ返す(SK =
   * `NOTIFICATION#<iso>#<ulid>` の並びをそのまま使う)。 invalid/foreign cursor は
   * 最初のページから(A3 と同じ)。 現行 caller (participant notifications) は cursor を
   * 渡さない — seam の cursor は将来のページング用で挙動不変。
   */
  listByEvent(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<NotificationsPage>;
  /**
   * TTL-equivalent sweep for SQL backends. DynamoDB has native TTL, but exposes
   * the same defensive manual sweep as Events / Teams so the pure-SQL runtime can
   * prune all expiring aggregates from one reconciler tick.
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}
