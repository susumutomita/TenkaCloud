import type { DisruptionAuditRow } from "../handlers/event-handler/disruption-types.js";
import type {
  DisruptionAuditPage,
  DisruptionClaimOutcome,
  DisruptionExecutionClaimInput,
  DisruptionRecurringMutationOutcome,
  DisruptionRecurringRecord,
  DisruptionsRepository,
  SqlExecutor,
} from "./types.js";

/**
 * [Issue #2442 / Phase C3] SQLite schema for the Disruptions aggregate. One SQL layer in the
 * SQLite dialect targets the Turso (libSQL) hosted backend (#2677: Turso-only).
 *
 * Unlike the DynamoDB backend (one physical table, four SK/PK shapes co-located), the SQL
 * backend uses one table per row shape — the established precedent for every other aggregate
 * in this codebase (e.g. Notifications/FeatureFlags co-habit the Events DynamoDB table but get
 * separate SQL tables, #2439). Each table denormalizes its lookup columns and stores the full
 * record as a JSON `payload` so new attributes round-trip without a migration (the same split
 * every other SQL repository in this file uses).
 */
export const DISRUPTIONS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS disruption_audit (
  event_id   TEXT    NOT NULL,
  sort_key   TEXT    NOT NULL,
  tenant_id  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (event_id, sort_key)
)`,
  `CREATE TABLE IF NOT EXISTS disruption_fire_claims (
  tenant_id  TEXT    NOT NULL,
  request_id TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, request_id)
)`,
  `CREATE TABLE IF NOT EXISTS disruption_recurring (
  event_id   TEXT    NOT NULL,
  request_id TEXT    NOT NULL,
  tenant_id  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (event_id, request_id)
)`,
  `CREATE TABLE IF NOT EXISTS disruption_exec_claims (
  claim_key  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (claim_key)
)`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const DISRUPTIONS_SCHEMA_SQL = `${DISRUPTIONS_SCHEMA_STATEMENTS.join(";\n")};`;

/**
 * SQLite dialect uniqueness-violation detector — duplicated from
 * `sql-competitor-accounts-repository.ts` (this codebase's established per-aggregate-file
 * convention, the helper is not shared across aggregate files).
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown };
  if (
    [code, extendedCode].some(
      (value) => value === "SQLITE_CONSTRAINT_PRIMARYKEY" || value === "SQLITE_CONSTRAINT_UNIQUE",
    )
  ) {
    return true;
  }
  return err.message.includes("UNIQUE constraint failed");
}

function auditSortKey(record: DisruptionAuditRow): string {
  return `${record.firedAt}#${record.auditId}`;
}

function rowToAuditRecord(payload: unknown): DisruptionAuditRow {
  return JSON.parse(String(payload)) as DisruptionAuditRow;
}

function rowToRecurringRecord(payload: unknown): DisruptionRecurringRecord {
  return JSON.parse(String(payload)) as DisruptionRecurringRecord;
}

/** `<requestId>#<teamId>[#INJECT|#RECUR#<firedAt>]` — SQL-side mirror of the DDB `EXEC#` key. */
function executionClaimKey(input: DisruptionExecutionClaimInput): string {
  if (input.phase === "inject") return `${input.requestId}#${input.teamId}#INJECT`;
  if (input.phase === "recurring") {
    return `${input.requestId}#${input.teamId}#RECUR#${input.firedAt}`;
  }
  return `${input.requestId}#${input.teamId}`;
}

/**
 * [Issue #2442 / Phase C3] SQLite implementation of {@link DisruptionsRepository}.
 */
export class SqlDisruptionsRepository implements DisruptionsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async claimFireIdempotency(draft: DisruptionAuditRow): Promise<DisruptionClaimOutcome> {
    try {
      await this.sql.run(
        "INSERT INTO disruption_fire_claims (tenant_id, request_id, expires_at, payload) VALUES (?, ?, ?, ?)",
        [draft.tenantId, draft.requestId, draft.expiresAt, JSON.stringify(draft)],
      );
      return { outcome: "claimed" };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return { outcome: "already" };
      throw err;
    }
  }

  async getFireIdempotencyRecord(
    tenantId: string,
    requestId: string,
  ): Promise<DisruptionAuditRow | undefined> {
    const row = await this.sql.get(
      "SELECT payload FROM disruption_fire_claims WHERE tenant_id = ? AND request_id = ?",
      [tenantId, requestId],
    );
    return row ? rowToAuditRecord(row.payload) : undefined;
  }

  async appendAudit(record: DisruptionAuditRow): Promise<void> {
    // Mirrors the DynamoDB backend: a `sort_key` collision (PRIMARY KEY violation) propagates
    // as an uncaught error (fail loud), not swallowed into an outcome union — the pre-seam
    // handler never caught the equivalent `ConditionalCheckFailedException` either.
    await this.sql.run(
      "INSERT INTO disruption_audit (event_id, sort_key, tenant_id, expires_at, payload) VALUES (?, ?, ?, ?, ?)",
      [
        record.eventId,
        auditSortKey(record),
        record.tenantId,
        record.expiresAt,
        JSON.stringify(record),
      ],
    );
  }

  async listAuditPage(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DisruptionAuditPage> {
    const after = opts.cursor ? decodeKeysetCursor(opts.cursor) : undefined;
    const rows = after
      ? await this.sql.all(
          "SELECT sort_key, payload FROM disruption_audit WHERE event_id = ? " +
            "AND sort_key < ? ORDER BY sort_key DESC LIMIT ?",
          [eventId, after.s, opts.limit + 1],
        )
      : await this.sql.all(
          "SELECT sort_key, payload FROM disruption_audit WHERE event_id = ? " +
            "ORDER BY sort_key DESC LIMIT ?",
          [eventId, opts.limit + 1],
        );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((row) => rowToAuditRecord(row.payload));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeKeysetCursor({ s: String(last.sort_key) }) : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async listAuditSince(eventId: string, sinceIso: string): Promise<readonly DisruptionAuditRow[]> {
    const rows = await this.sql.all(
      "SELECT payload FROM disruption_audit WHERE event_id = ? AND sort_key >= ? ORDER BY sort_key ASC",
      [eventId, sinceIso],
    );
    return rows.map((row) => rowToAuditRecord(row.payload));
  }

  async putRecurringRegistry(record: DisruptionRecurringRecord): Promise<void> {
    await this.sql.run(
      "INSERT INTO disruption_recurring (event_id, request_id, tenant_id, expires_at, payload) VALUES (?, ?, ?, ?, ?)",
      [record.eventId, record.requestId, record.tenantId, record.expiresAt, JSON.stringify(record)],
    );
  }

  async listRecurringByEvent(
    eventId: string,
    tenantId: string,
  ): Promise<readonly DisruptionRecurringRecord[]> {
    const rows = await this.sql.all(
      "SELECT payload FROM disruption_recurring WHERE event_id = ? AND tenant_id = ?",
      [eventId, tenantId],
    );
    return rows.map((row) => rowToRecurringRecord(row.payload));
  }

  async getRecurringRegistry(
    eventId: string,
    requestId: string,
  ): Promise<DisruptionRecurringRecord | undefined> {
    const row = await this.sql.get(
      "SELECT payload FROM disruption_recurring WHERE event_id = ? AND request_id = ?",
      [eventId, requestId],
    );
    return row ? rowToRecurringRecord(row.payload) : undefined;
  }

  async cancelRecurringRegistry(
    eventId: string,
    requestId: string,
    tenantId: string,
    cancelledAt: string,
  ): Promise<DisruptionRecurringMutationOutcome> {
    const rows = await this.sql.all(
      `UPDATE disruption_recurring
       SET payload = json_set(payload, '$.cancelledAt', ?)
       WHERE event_id = ? AND request_id = ? AND tenant_id = ?
       RETURNING payload`,
      [cancelledAt, eventId, requestId, tenantId],
    );
    return rows[0] ? { outcome: "updated" } : { outcome: "not_found" };
  }

  async claimExecutionSlot(input: DisruptionExecutionClaimInput): Promise<DisruptionClaimOutcome> {
    try {
      await this.sql.run(
        "INSERT INTO disruption_exec_claims (claim_key, expires_at, payload) VALUES (?, ?, ?)",
        [
          executionClaimKey(input),
          input.expiresAt,
          JSON.stringify({
            disruptionId: input.disruptionId,
            eventId: input.eventId,
            problemId: input.problemId,
            tenantId: input.tenantId,
            teamId: input.teamId,
            requestId: input.requestId,
            firedAt: input.firedAt,
          }),
        ],
      );
      return { outcome: "claimed" };
    } catch (err) {
      if (isUniqueConstraintViolation(err)) return { outcome: "already" };
      throw err;
    }
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const results = await Promise.all([
      this.sql.run("DELETE FROM disruption_audit WHERE expires_at > 0 AND expires_at <= ?", [
        nowEpochSeconds,
      ]),
      this.sql.run("DELETE FROM disruption_fire_claims WHERE expires_at > 0 AND expires_at <= ?", [
        nowEpochSeconds,
      ]),
      this.sql.run("DELETE FROM disruption_recurring WHERE expires_at > 0 AND expires_at <= ?", [
        nowEpochSeconds,
      ]),
      this.sql.run("DELETE FROM disruption_exec_claims WHERE expires_at > 0 AND expires_at <= ?", [
        nowEpochSeconds,
      ]),
    ]);
    return results.reduce((sum, r) => sum + Number(r.changes), 0);
  }
}

interface DisruptionAuditKeysetCursor {
  readonly s: string;
}

function encodeKeysetCursor(cursor: DisruptionAuditKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeKeysetCursor(cursor: string): DisruptionAuditKeysetCursor | undefined {
  if (cursor.length > 512) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { s } = parsed as Partial<DisruptionAuditKeysetCursor>;
  if (typeof s !== "string" || s.length < 1 || s.length > 256) return undefined;
  return { s };
}
