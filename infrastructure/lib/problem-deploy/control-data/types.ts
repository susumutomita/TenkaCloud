import type { EventItem } from "../handlers/event-handler/types.js";

/**
 * [ADR-049 §5.1] Control-plane data behind a repository seam.
 *
 * `EventRecord` is the domain shape of one competition Event, derived from the
 * canonical DynamoDB row (`EventItem`) minus its physical DDB keys
 * (PK / SK / GSI1PK / GSI1SK). Those keys are an implementation detail of the
 * DynamoDB backend; the SQLite backends (Turso / D1) derive their own
 * keys / columns. Deriving from `EventItem` keeps this shape in lock-step with
 * the handler layer — a new event attribute automatically flows through the seam
 * without a second edit here.
 */
export type EventRecord = Omit<EventItem, "PK" | "SK" | "GSI1PK" | "GSI1SK">;

/**
 * [ADR-049 §5.1] Aggregate-scoped repository for the Events aggregate — domain
 * methods, not a generic key-value shim. Two interchangeable backends implement
 * it: {@link DynamoDbEventsRepository} (status quo, the default) and
 * {@link SqlEventsRepository} (one SQL layer, SQLite dialect for Turso / D1).
 * Selection happens at cold start via the `CONTROL_DATA_BACKEND` flag through
 * {@link createEventsRepository}.
 */
export interface EventsRepository {
  /**
   * Tenant-scoped point read. Returns `undefined` when the event is absent or
   * belongs to a different tenant (404-equivalent, never leaks another tenant's
   * row).
   */
  getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined>;
  /** Upsert one event row. */
  putEvent(record: EventRecord): Promise<void>;
  /**
   * All events for a tenant, newest-first by `createdAt` (mirrors the DynamoDB
   * GSI1 query with `ScanIndexForward=false`).
   */
  listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]>;
  /**
   * TTL-equivalent sweep: delete events whose `expiresAt` (epoch seconds, `> 0`)
   * is at or before `nowEpochSeconds`, and return the number deleted. DynamoDB
   * has native TTL; the SQLite backends have none (ADR-049 §5.2) and rely on this
   * being run on a schedule.
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}

/** Backend selector value carried by the `CONTROL_DATA_BACKEND` flag. */
export type ControlDataBackend = "dynamodb" | "turso" | "sql";

/** Positional bind parameter accepted by {@link SqlExecutor}. */
export type SqlParam = string | number | bigint | null;
/** One result row, keyed by column name. */
export type SqlRow = Record<string, unknown>;
/** Result of a mutating statement (`INSERT` / `UPDATE` / `DELETE`). */
export interface SqlRunResult {
  readonly changes: number | bigint;
}

/**
 * [ADR-049 §5.1] Minimal injected SQL driver so {@link SqlEventsRepository} stays
 * decoupled from any concrete client. Node's built-in `node:sqlite`
 * (`DatabaseSync`) backs it for tests and offline validation; a production
 * `@libsql/client` (Turso / self-hosted sqld) adapter — and a Cloudflare D1
 * binding adapter — map onto the same three methods.
 *
 * TODO(ADR-049 §5.2 follow-up): add the `@libsql/client` adapter (Turso) and the
 * D1 binding adapter. This is deferred deliberately — adding `@libsql/client` is
 * a supply-chain-sensitive dependency decision handled separately — so this seam
 * introduces NO new runtime dependency.
 */
export interface SqlExecutor {
  run(sql: string, params?: readonly SqlParam[]): SqlRunResult | Promise<SqlRunResult>;
  get(sql: string, params?: readonly SqlParam[]): SqlRow | undefined | Promise<SqlRow | undefined>;
  all(sql: string, params?: readonly SqlParam[]): readonly SqlRow[] | Promise<readonly SqlRow[]>;
}
