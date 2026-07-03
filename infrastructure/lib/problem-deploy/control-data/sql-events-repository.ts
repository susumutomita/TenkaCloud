import type { EventRecord, EventsRepository, SqlExecutor } from "./types.js";

/**
 * [ADR-049 §5.1 / §5.2] SQLite implementation of {@link EventsRepository}. One
 * SQL layer in the SQLite dialect covers both Turso (libSQL) and Cloudflare D1;
 * switching hosts is a driver swap, not a rewrite. It talks to an injected
 * {@link SqlExecutor} so it carries no client dependency of its own — `node:sqlite`
 * backs it in tests, a future `@libsql/client` adapter backs it in production.
 *
 * Schema: the full record is stored as a JSON `payload` so new event attributes
 * round-trip without a migration, with denormalized columns for the query paths
 * that must be indexable (tenant listing, TTL prune) rather than JSON-scanned.
 */
export const EVENTS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
  event_id   TEXT    PRIMARY KEY,
  tenant_id  TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_events_tenant_created
  ON events (tenant_id, created_at DESC)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const EVENTS_SCHEMA_SQL = `${EVENTS_SCHEMA_STATEMENTS.join(";\n")};`;

export class SqlEventsRepository implements EventsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined> {
    const row = await this.sql.get("SELECT tenant_id, payload FROM events WHERE event_id = ?", [
      eventId,
    ]);
    // Same guard as the DDB backend: absent row or tenant mismatch → undefined.
    if (!row || row.tenant_id !== tenantId) return undefined;
    return JSON.parse(String(row.payload)) as EventRecord;
  }

  async putEvent(record: EventRecord): Promise<void> {
    await this.sql.run(
      "INSERT INTO events (event_id, tenant_id, status, created_at, expires_at, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(event_id) DO UPDATE SET " +
        "tenant_id = excluded.tenant_id, status = excluded.status, " +
        "created_at = excluded.created_at, expires_at = excluded.expires_at, " +
        "payload = excluded.payload",
      [
        record.eventId,
        record.tenantId,
        record.status,
        record.createdAt,
        record.expiresAt,
        JSON.stringify(record),
      ],
    );
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.sql.run("DELETE FROM events WHERE event_id = ?", [eventId]);
  }

  async listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]> {
    const rows = await this.sql.all(
      // event_id tiebreak keeps ordering deterministic when createdAt collides.
      "SELECT payload FROM events WHERE tenant_id = ? ORDER BY created_at DESC, event_id DESC",
      [tenantId],
    );
    return rows.map((row) => JSON.parse(String(row.payload)) as EventRecord);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM events WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}
