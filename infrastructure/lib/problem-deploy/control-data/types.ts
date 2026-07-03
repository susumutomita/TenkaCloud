import type { EventItem, TeamItem } from "../handlers/event-handler/types.js";

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

/**
 * [ADR-049 §5.1] Team aggregate の domain shape。 canonical な DynamoDB 行 (`TeamItem`)
 * から物理 DDB キー (PK / SK / GSI1PK / GSI1SK / GSI2PK / GSI2SK) を除いたもの。 これらの
 * キーは DynamoDB backend の実装詳細であり、 SQLite backend (Turso / D1) は独自の
 * キー / カラムを導出する。 `TeamItem` から派生させることで handler 層と歩調を合わせ、
 * team 属性を 1 つ追加してもこの seam を二度直さずに流れる。
 *
 * The domain shape of one competition Team, derived from the canonical DynamoDB
 * row (`TeamItem`) minus its physical DDB keys (PK / SK / GSI1PK / GSI1SK /
 * GSI2PK / GSI2SK — six keys, mirroring the sparse participant-login GSI2). Those
 * keys are an implementation detail of the DynamoDB backend; the SQLite backends
 * derive their own keys / columns.
 */
export type TeamRecord = Omit<TeamItem, "PK" | "SK" | "GSI1PK" | "GSI1SK" | "GSI2PK" | "GSI2SK">;

/**
 * [ADR-049 §5.1] Aggregate-scoped repository for the Teams aggregate — domain
 * methods, not a generic key-value shim (mirror of {@link EventsRepository}). Two
 * interchangeable backends implement it: {@link DynamoDbTeamsRepository} (status
 * quo, the default) and {@link SqlTeamsRepository} (one SQL layer, SQLite dialect
 * for Turso / D1). Selection happens at cold start via the `CONTROL_DATA_BACKEND`
 * flag through {@link createTeamsRepository}.
 *
 * すべてのメソッドは既存の実アクセスパターン (create.ts の team 書込み /
 * event-handler/list.ts の team 一覧 / participant portal の teamLoginKey lookup) に
 * 対応する — 投機的な API は 1 つも含まない。
 */
export interface TeamsRepository {
  /**
   * Tenant-scoped point read. Returns `undefined` when the team is absent or
   * belongs to a different tenant (404-equivalent, never leaks another tenant's
   * row). Tenant / event / team の 3 段スコープで 1 行を引く。
   */
  getTeam(tenantId: string, eventId: string, teamId: string): Promise<TeamRecord | undefined>;
  /**
   * Participant bearer lookup by `teamLoginKey` (the DynamoDB GSI2 sparse index,
   * `TEAMKEY#<key>`). Returns `undefined` when no team carries that key.
   *
   * **[Issue #2290]** The SQLite backend indexes only a SHA-256 *hash* of the
   * login key ({@link SqlTeamsRepository}), so the plaintext bearer never lands in
   * an index column. Callers pass the plaintext key to both backends and get the
   * same team back.
   */
  getTeamByLoginKey(loginKey: string): Promise<TeamRecord | undefined>;
  /**
   * すべての team を 1 event 分だけ返す (DynamoDB では
   * `PK = EVENT#<eventId> AND begins_with(SK, "TEAM#")` の base-table query)。
   * teamId 昇順で並べ、 backend 間で決定的な順序を保証する。
   */
  listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]>;
  /** Upsert one team row. */
  putTeam(record: TeamRecord): Promise<void>;
  /**
   * TTL-equivalent sweep: delete teams whose `expiresAt` (epoch seconds, `> 0`)
   * is at or before `nowEpochSeconds`, and return the number deleted. DynamoDB has
   * native TTL; the SQLite backends have none (ADR-049 §5.2) and rely on this being
   * run on a schedule (mirror of {@link EventsRepository.pruneExpired}).
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
