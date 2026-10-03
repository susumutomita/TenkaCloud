/**
 * [Issue #2527 Slice 1] AdminAuditLog aggregate — physical row shape and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

// ---------------------------------------------------------------------------
// [Issue #2442] AdminAuditLog aggregate (Issue #950).
//
// Physical shape (unchanged, `admin-audit-log-table.ts`):
//   PK = `TENANT#<tenantId>` (tenant-scoped operation) | `SYSTEM#<env>` (SystemAdmin operation)
//   SK = `AUDIT#<ulid>`                                                    (append-only)
// GSI1 (`ACTOR#<sub>` PK / occurredAt SK, "actor did what" reverse lookup) is written on every
// row but never queried by any handler today (grep-confirmed, same status as Disruptions' GSI1)
// — the DynamoDB backend still writes it (byte-identical Put) for forward compatibility, the SQL
// backend has no equivalent index. TTL = `AUDIT_RETENTION_DAYS` (90 default / 365 SOC2, epoch
// seconds) on every row.
//
// Unlike every other C-phase aggregate, the SYSTEM-vs-TENANT partition choice (`tenantId ===
// "SYSTEM"` sentinel) and ULID/TTL generation are **caller** business logic
// (`handlers/shared/audit-log.ts`'s `writeAuditEvent`), not a pure function of a domain record's
// own fields — so this repository is a thinner data-access layer than DisruptionsRepository:
// `appendAudit` takes an already physically-keyed row instead of deriving PK/SK internally.
// ---------------------------------------------------------------------------

/**
 * [Issue #2442 / Phase C4] One physical row of the AdminAuditLog aggregate. `pk`/`sk`/`gsi1pk`/
 * `gsi1sk` are precomputed by the caller (see the section comment above for why). Field names
 * otherwise match {@link AdminAuditLogRepository} 1:1 with the pre-seam `writeAuditEvent` Item /
 * `audit-log-read.ts` and `admin-insight-handler/audit.ts`'s parsed row shape.
 */
export interface AdminAuditRow {
  readonly pk: string;
  readonly sk: string;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  readonly actor: string;
  readonly actorUsername?: string;
  readonly action: string;
  readonly outcome: string;
  readonly target?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  /** ISO8601, caller-formatted from `occurredAtMs`. */
  readonly occurredAt: string;
  /** Epoch seconds (DynamoDB native TTL attribute name `ttl`); SQL backends sweep it manually. */
  readonly ttl: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** [Issue #2442 / Phase C4] One page of {@link AdminAuditLogRepository.listPage}. */
export interface AdminAuditLogPage {
  readonly items: readonly AdminAuditRow[];
  readonly nextCursor?: string;
}

/**
 * [Issue #2442 / Phase C4] Aggregate-scoped repository for the AdminAuditLog aggregate. Two
 * interchangeable backends: {@link DynamoDbAdminAuditLogRepository} (status quo, default) and
 * {@link SqlAdminAuditLogRepository} (SQLite dialect for Turso / D1). Selection happens at cold
 * start via `CONTROL_DATA_BACKEND` through {@link createAdminAuditLogRepository}.
 *
 * Three call sites: `handlers/shared/audit-log.ts`'s `writeAuditEvent` (write, best-effort —
 * the seam itself throws on failure, `writeAuditEvent` catches and warns, preserving the
 * existing fail-safe contract), `handlers/event-handler/audit-log-read.ts` (tenant-scoped read,
 * PK fixed to the caller's own tenant), and `admin-insight-handler/audit.ts` (SystemAdmin
 * cross-tenant read, PK is either tenant- or system-scoped per the `scope` query param).
 */
export interface AdminAuditLogRepository {
  /**
   * Appends one audit row. Verbatim relocation of the pre-seam unconditional Put — no
   * `ConditionExpression` (unlike {@link DisruptionsRepository.appendAudit}'s `AUDIT#` rows),
   * matching the pre-seam handler, which never guarded against a ULID collision here either.
   */
  appendAudit(row: AdminAuditRow): Promise<void>;
  /**
   * Cursor-paginated query for one partition (`pk`), newest-first. The DynamoDB backend's cursor
   * wire format is byte-identical to the pre-seam `audit-log-read.ts` / `admin-insight-handler/
   * audit.ts` (plain base64 JSON of `LastEvaluatedKey`, not the shared/cursor-codec allowlist
   * codec — no wire-format break for a cursor a client already holds across this seam's deploy).
   */
  listPage(
    pk: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<AdminAuditLogPage>;
  /**
   * Bounded full-partition drain for CSV export, newest-first (mirrors the pre-seam
   * `queryAllItemsBounded` / recursive-page-loop drains both read call sites performed inline).
   * `maxPages` bounds memory / round-trips; callers apply their own row-count truncation.
   */
  listAllByPartition(
    pk: string,
    opts: { readonly pageSize: number; readonly maxPages: number },
  ): Promise<readonly AdminAuditRow[]>;
  /**
   * TTL-equivalent sweep for SQL backends (mirrors {@link DisruptionsRepository.pruneExpired}).
   * DynamoDB has native TTL on `ttl`; the SQLite backends have none and rely on
   * this being run on the manual-prune tick.
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}
