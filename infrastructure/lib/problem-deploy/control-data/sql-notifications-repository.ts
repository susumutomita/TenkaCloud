import type {
  NotificationRecord,
  NotificationsPage,
  NotificationsRepository,
  SqlExecutor,
} from "./types.js";

export const NOTIFICATIONS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications (
  event_id   TEXT    NOT NULL,
  sort_key   TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (event_id, sort_key)
)`,
] as const;

export const NOTIFICATIONS_SCHEMA_SQL = `${NOTIFICATIONS_SCHEMA_STATEMENTS.join(";\n")};`;

interface NotificationsKeysetCursor {
  readonly s: string;
}

function notificationSortKey(record: NotificationRecord): string {
  return `${record.occurredAt}#${record.notificationId}`;
}

function encodeKeysetCursor(cursor: NotificationsKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeKeysetCursor(cursor: string): NotificationsKeysetCursor | undefined {
  if (cursor.length > 512) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { s } = parsed as Partial<NotificationsKeysetCursor>;
  if (typeof s !== "string" || s.length < 1 || s.length > 256) return undefined;
  return { s };
}

export class SqlNotificationsRepository implements NotificationsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async append(record: NotificationRecord): Promise<void> {
    await this.sql.run(
      "INSERT INTO notifications (event_id, sort_key, expires_at, payload) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(event_id, sort_key) DO UPDATE SET " +
        "expires_at = excluded.expires_at, payload = excluded.payload",
      [record.eventId, notificationSortKey(record), record.expiresAt, JSON.stringify(record)],
    );
  }

  async listByEvent(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<NotificationsPage> {
    const after = opts.cursor ? decodeKeysetCursor(opts.cursor) : undefined;
    const rows = after
      ? await this.sql.all(
          "SELECT sort_key, payload FROM notifications WHERE event_id = ? " +
            "AND sort_key < ? ORDER BY sort_key DESC LIMIT ?",
          [eventId, after.s, opts.limit + 1],
        )
      : await this.sql.all(
          "SELECT sort_key, payload FROM notifications WHERE event_id = ? " +
            "ORDER BY sort_key DESC LIMIT ?",
          [eventId, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const notifications = page.map((row) => JSON.parse(String(row.payload)) as NotificationRecord);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeKeysetCursor({ s: String(last.sort_key) }) : undefined;
    return { notifications, nextCursor };
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM notifications WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}
