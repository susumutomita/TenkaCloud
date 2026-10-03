import type {
  AdminAuditLogPage,
  AdminAuditLogRepository,
  AdminAuditRow,
  SqlExecutor,
} from "./types.js";

/**
 * [Issue #2442 / Phase C4] SQLite schema for the AdminAuditLog aggregate. One SQL layer in the
 * SQLite dialect targets the Turso (libSQL) hosted backend (#2677: Turso-only).
 *
 * One table for the aggregate's single row shape (append-only audit rows). GSI1 (`ACTOR#<sub>`
 * reverse lookup) is never queried by any handler today (grep-confirmed, same status on the
 * DynamoDB backend) so it has no SQL equivalent — the established precedent for an unused index
 * (Disruptions' GSI1). The full record round-trips as a JSON `payload` so new attributes don't
 * need a migration (the same split every other SQL repository in this codebase uses).
 */
export const ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
  pk          TEXT    NOT NULL,
  sk          TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  payload     TEXT    NOT NULL,
  PRIMARY KEY (pk, sk)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const ADMIN_AUDIT_LOG_SCHEMA_SQL = `${ADMIN_AUDIT_LOG_SCHEMA_STATEMENTS.join(";\n")};`;

function rowToRecord(payload: unknown): AdminAuditRow {
  return JSON.parse(String(payload)) as AdminAuditRow;
}

interface AdminAuditKeysetCursor {
  readonly s: string;
}

function encodeKeysetCursor(cursor: AdminAuditKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeKeysetCursor(cursor: string): AdminAuditKeysetCursor | undefined {
  if (cursor.length > 512) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { s } = parsed as Partial<AdminAuditKeysetCursor>;
  if (typeof s !== "string" || s.length < 1 || s.length > 256) return undefined;
  return { s };
}

/**
 * [Issue #2442 / Phase C4] SQLite implementation of {@link AdminAuditLogRepository}. Unlike the
 * DynamoDB backend, cursors here are a fresh keyset format (base64url, mirrors
 * `sql-disruptions-repository.ts`'s `listAuditPage`) — there is no pre-existing SQL cursor
 * contract to preserve, only the DynamoDB backend has the byte-compatibility requirement.
 */
export class SqlAdminAuditLogRepository implements AdminAuditLogRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async appendAudit(row: AdminAuditRow): Promise<void> {
    // Mirrors the DynamoDB backend: no uniqueness guard (verbatim relocation — the pre-seam
    // handler never guarded against a ULID collision on this row shape either). A `PRIMARY KEY`
    // collision would propagate as an uncaught error, same as the DynamoDB backend's Put would
    // simply overwrite (both are unreachable in practice — ULID collision probability is
    // negligible).
    await this.sql.run(
      "INSERT INTO admin_audit_log (pk, sk, expires_at, payload) VALUES (?, ?, ?, ?)",
      [row.pk, row.sk, row.ttl, JSON.stringify(row)],
    );
  }

  async listPage(
    pk: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<AdminAuditLogPage> {
    const after = opts.cursor ? decodeKeysetCursor(opts.cursor) : undefined;
    const rows = after
      ? await this.sql.all(
          "SELECT sk, payload FROM admin_audit_log WHERE pk = ? AND sk < ? ORDER BY sk DESC LIMIT ?",
          [pk, after.s, opts.limit + 1],
        )
      : await this.sql.all(
          "SELECT sk, payload FROM admin_audit_log WHERE pk = ? ORDER BY sk DESC LIMIT ?",
          [pk, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((row) => rowToRecord(row.payload));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeKeysetCursor({ s: String(last.sk) }) : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listAllByPartition(
    pk: string,
    opts: { readonly pageSize: number; readonly maxPages: number },
  ): Promise<readonly AdminAuditRow[]> {
    const collected: AdminAuditRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < opts.maxPages; page++) {
      const result = await this.listPage(pk, { limit: opts.pageSize, cursor });
      collected.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return collected;
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM admin_audit_log WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}
