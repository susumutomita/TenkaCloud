import type { EventItem, TeamItem } from "../handlers/event-handler/types.js";
import type { NotificationItem } from "../handlers/shared/notification.js";
import type { ProgressionGateConfig } from "../handlers/shared/progression-gate.js";
import type { TenantFeatureFlagsItem } from "../handlers/shared/tenant-feature-flags.js";

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
 * [Issue #2437 / Phase A2] Result of one conditional Event mutation. DynamoDB
 * signals a failed `ConditionExpression` by throwing
 * `ConditionalCheckFailedException`, while SQL backends signal it with
 * `changes = 0` — this discriminated union absorbs both so handlers branch on
 * data instead of catching backend-specific exceptions.
 *
 * - `updated`  — the conditional write applied. `event` carries the post-image
 *   when the underlying write returns it (DynamoDB `ReturnValues: ALL_NEW` /
 *   SQL `UPDATE … RETURNING`); methods whose DynamoDB call historically ran
 *   without `ReturnValues` omit it (the DDB request stays byte-identical).
 * - `conflict` — the row exists but the state condition did not hold. `event`
 *   carries the probe read when the method probes on conflict (mirrors the
 *   pre-seam CCF-catch + Get pattern); fire-and-forget methods skip the probe
 *   and omit it.
 * - `not_found` — the row is absent or belongs to another tenant
 *   (404-equivalent, never leaks another tenant's row).
 */
export type EventMutationOutcome =
  | { readonly outcome: "updated"; readonly event?: EventRecord }
  | { readonly outcome: "conflict"; readonly event?: EventRecord }
  | { readonly outcome: "not_found" };

/**
 * [Issue #2437] Result of {@link EventsRepository.clearProgressionGate}.
 * `removed` distinguishes "a gate was actually removed" from the idempotent
 * no-gate case (DynamoDB derives it from `ReturnValues: ALL_OLD`; SQL from a
 * gate-present conditional `UPDATE … RETURNING`).
 */
export type ClearProgressionGateOutcome =
  | { readonly outcome: "updated"; readonly removed: boolean }
  | { readonly outcome: "not_found" };

/**
 * [Issue #2437] Result of {@link EventsRepository.createEventWithTeams}.
 * `conflict` = a uniqueness constraint fired (DynamoDB `attribute_not_exists`
 * cancellation / SQL PRIMARY KEY or UNIQUE violation) and **nothing** was
 * written — both backends write the event + teams atomically.
 */
export type CreateEventWithTeamsOutcome =
  | { readonly outcome: "created" }
  | { readonly outcome: "conflict" };

/**
 * [Issue #2437] Partial schedule update for
 * {@link EventsRepository.updateSchedule}. Only the defined fields are written
 * (mirrors the pre-seam dynamic `SET` expression); validation of the values is
 * the caller's responsibility (`setEventSchedule`).
 */
export interface EventSchedulePatch {
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly teardownAt?: string;
  readonly deployAt?: string;
  readonly scoreboardFreezeMinutes?: number;
}

/**
 * [Issue #2437] Which scheduled-action audit stamp
 * {@link EventsRepository.markScheduleFired} writes: `teardown` →
 * `teardownFiredAt`, `deploy` → `deployFiredAt` (ADR-047 / follow-up).
 */
export type ScheduleFiredKind = "teardown" | "deploy";

/**
 * [Issue #2438 / Phase A3] One page of {@link EventsRepository.listEventsPage}.
 * `nextCursor` is an **opaque** token — its shape is a backend implementation
 * detail (DDB: the pre-seam `ExclusiveStartKey` cursor codec, byte-identical
 * wire format; SQL: a `(createdAt, eventId)` keyset token). A cursor minted by
 * one backend is never valid on the other; callers must not decode it
 * themselves.
 */
export interface EventsPage {
  readonly events: readonly EventRecord[];
  readonly nextCursor?: string;
}

/**
 * [#2439 / Phase A4] Notifications aggregate の domain shape(EventRecord と同じ流儀で
 * 物理 DDB キーを除いたもの)。 SK 導出 (`NOTIFICATION#<occurredAt>#<notificationId>`) は
 * DynamoDB backend の実装詳細。
 */
export type NotificationRecord = Omit<NotificationItem, "PK" | "SK">;

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
}

/** [#2439] TenantFeatureFlags の domain shape(tenantId / flags / updatedAt / updatedBy)。 */
export type TenantFeatureFlagsRecord = Omit<TenantFeatureFlagsItem, "PK" | "SK">;

export interface FeatureFlagsRepository {
  /** 行が無い(未保存)→ undefined。 caller 側 helper が `{}` に畳む(現行挙動)。 */
  get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined>;
  /**
   * 全置換 upsert(admin Settings 保存)。 audit fields (updatedAt/updatedBy) を含む
   * record 全体を渡す — issue 本文の `put(tenantId, flags)` から意図的に refine
   * (putEvent(record) の先行 precedent と同型、 audit fields を落とさないため)。
   */
  put(record: TenantFeatureFlagsRecord): Promise<void>;
}

/**
 * [Issue #2438 / Phase A3] Scoring-gate fields the generic-scoring reconciler
 * reads per distinct `eventId` in a tick (`scoringLocked` gate + Progression
 * Gate config). Mirrors the pre-seam handler's local `EventScoringMeta`.
 */
export interface EventScoringMeta {
  readonly scoringLocked: boolean;
  readonly progressionGate: ProgressionGateConfig | undefined;
}

/**
 * [ADR-049 §5.1] Aggregate-scoped repository for the Events aggregate — domain
 * methods, not a generic key-value shim. Two interchangeable backends implement
 * it: {@link DynamoDbEventsRepository} (status quo, the default) and
 * {@link SqlEventsRepository} (one SQL layer, SQLite dialect for Turso / D1).
 * Selection happens at cold start via the `CONTROL_DATA_BACKEND` flag through
 * {@link createEventsRepository}.
 *
 * [Issue #2437 / Phase A2] Conditional/atomic writes are domain methods with an
 * {@link EventMutationOutcome} union return. Fixed contract: (a) outcomes are
 * data, not exceptions; (b) the DynamoDB backend keeps the pre-seam
 * Update/Condition expressions byte-identical; (c) every conditional mutation
 * of an existing row includes the tenant check in its condition (no
 * cross-tenant write can succeed). `createEventWithTeams` writes only NEW rows
 * whose `tenantId` is part of the record payload itself, so its uniqueness
 * conditions carry no separate tenant predicate (same as the pre-seam
 * TransactWrite).
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
  /** Delete one event row by its domain identifier. */
  deleteEvent(eventId: string): Promise<void>;
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

  /**
   * [#494 / #1095] READY → ENDED transition: stamps `endsAt` / `updatedAt` = `at`
   * and auto-locks scoring (`scoringLocked` + audit fields, lockedBy =
   * `system:end-event`). Only READY events can end; `conflict` carries the probed
   * event so the caller can surface the blocking status.
   */
  endEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome>;
  /**
   * [#558] Sets `scoringLocked = true` + audit fields. Allowed only while
   * READY / ENDED and currently unlocked; `conflict` carries the probed event so
   * the caller can tell "already locked" from "not lockable".
   */
  lockScoring(
    tenantId: string,
    eventId: string,
    lockedBy: string,
    at: string,
  ): Promise<EventMutationOutcome>;
  /**
   * [#558] Removes `scoringLocked` + audit fields (reversible lock). Allowed only
   * while READY / ENDED and currently locked; `conflict` carries the probed event.
   */
  unlockScoring(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome>;
  /**
   * [#493] Soft delete: DRAFT / ENDED / TEARDOWN → ARCHIVED with `archivedAt`.
   * `conflict` carries the probed event (in-flight or already-archived status).
   */
  archiveEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome>;
  /**
   * [#536 / #537 / ADR-047] Partial schedule update — writes only the fields
   * present in `patch` plus `updatedAt`. The condition is tenant-scope only, so
   * the union never yields `conflict` (a failed condition means the row is
   * absent or foreign → `not_found`).
   */
  updateSchedule(
    tenantId: string,
    eventId: string,
    patch: EventSchedulePatch,
    at: string,
  ): Promise<EventMutationOutcome>;
  /**
   * [#557] Marks the event TEARDOWN unless it is already ARCHIVED (an archived
   * event must not regress). Fire-and-forget shape: no probe on `conflict`
   * (callers skip, matching the pre-seam CCF-swallow), so `conflict` also covers
   * the absent-row case.
   */
  markTeardown(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome>;
  /**
   * [#2283] Saves the Progression Gate config. Tenant-scope condition only —
   * a failed condition folds to `not_found` (mirrors the pre-seam handler).
   */
  setProgressionGate(
    tenantId: string,
    eventId: string,
    config: ProgressionGateConfig,
    at: string,
  ): Promise<EventMutationOutcome>;
  /**
   * [#2283] Removes the Progression Gate config (idempotent — `removed: false`
   * when no gate was set). Tenant-scope condition only.
   */
  clearProgressionGate(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<ClearProgressionGateOutcome>;
  /**
   * [Phase 2a] Advances the event to DEPLOYING from DRAFT / READY / DEPLOYING
   * only (never rolls back a later status). Fire-and-forget shape: no probe on
   * `conflict` (callers treat it as a no-op).
   */
  markDeploying(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome>;
  /**
   * [#557 / #539] Optimistic CAS for the reconciler: `from` → `to` only while the
   * status still equals `from` (an operator race loses ⇒ `conflict`, the caller
   * skips and re-evaluates next tick). No probe on `conflict` — the reconciler
   * never needs the reason, and the pre-seam path spent no extra read.
   */
  transitionStatus(
    tenantId: string,
    eventId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<EventMutationOutcome>;
  /**
   * [ADR-047] Idempotently stamps `teardownFiredAt` / `deployFiredAt` = `at`
   * (audit + double-fire guard). `conflict` = already stamped; no probe.
   * Deliberately does NOT touch `updatedAt` (byte-parity with the pre-seam
   * reconciler write).
   */
  markScheduleFired(
    tenantId: string,
    eventId: string,
    kind: ScheduleFiredKind,
    at: string,
  ): Promise<EventMutationOutcome>;
  /**
   * [#2437] Atomically creates one event row plus up to 99 team rows —
   * all-or-nothing on both backends (DynamoDB TransactWrite / SQL write
   * transaction). A uniqueness violation on any row converts to `conflict`
   * with nothing written. Throws on more than 99 teams (DynamoDB's 100-item
   * transaction cap, minus the event row; the SQL backend enforces the same cap
   * for parity).
   */
  createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<CreateEventWithTeamsOutcome>;
  /**
   * [#2438 / Phase A3] Cursor-paginated tenant listing (newest-first by
   * `createdAt`, mirrors {@link listEventsByTenant}'s ordering). Unlike
   * `listEventsByTenant` (full-page drain, no cursor — required for the
   * caller's own internal use), this is the seam for a UI list view: it
   * returns at most `opts.limit` events plus an opaque `nextCursor` when more
   * remain. `opts.cursor` replays a prior `nextCursor`; an absent/invalid
   * cursor starts from the first page.
   */
  listEventsPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<EventsPage>;
  /**
   * [#2438 / Phase A3] Cross-tenant status scan for the auto-transition
   * reconciler (moved from `event-reconciler.ts`'s base-table Scan). Returns
   * every event across every tenant whose `status` is one of `statuses`
   * (full-page drain — the reconciler must not miss a matching event to a
   * later Scan page). Returns `[]` for an empty `statuses` array without
   * issuing a request.
   */
  listEventsByStatus(statuses: readonly string[]): Promise<readonly EventRecord[]>;
  /**
   * [#2438 / Phase A3] Batch scoring-meta read for the generic-scoring tick
   * (moved from `generic-scoring-handler/index.ts`'s BatchGet). Returns a map
   * keyed by `eventId`; an id with no matching row is simply absent from the
   * map (callers that need fail-closed behavior on a read error handle that
   * themselves — this method propagates errors, it does not swallow them).
   * Returns an empty map for an empty `eventIds` array without issuing a
   * request. `eventIds` is deduplicated internally before dispatch and must
   * contain at most 100 distinct ids per call (mirrors DynamoDB
   * BatchGetItem's own duplicate-key / 100-key-per-request limits — both
   * backends enforce this symmetrically for parity, the same precedent as
   * `createEventWithTeams`'s 100-item TransactWrite cap).
   */
  batchGetEvents(eventIds: readonly string[]): Promise<ReadonlyMap<string, EventScoringMeta>>;
  /**
   * [#2438 / Phase A3] Tenant event count (moved from admin-insight
   * `summary.ts`'s `Select: COUNT` query, full-page drain).
   */
  countEventsByTenant(tenantId: string): Promise<number>;
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
export type TeamRecord = Omit<
  TeamItem,
  "PK" | "SK" | "GSI1PK" | "GSI1SK" | "GSI2PK" | "GSI2SK" | "teamLoginKey"
> & {
  /**
   * Present for DynamoDB reads and when the caller already supplied the key.
   * SQL point/list payloads deliberately omit the plaintext bearer.
   */
  readonly teamLoginKey?: string;
};

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
  /** Delete one team row by its event/team domain identifiers. */
  deleteTeam(eventId: string, teamId: string): Promise<void>;
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
/** One parameterized statement for {@link SqlExecutor.batch}. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
}

/**
 * [ADR-049 §5.1] Minimal injected SQL driver so {@link SqlEventsRepository} stays
 * decoupled from any concrete client. Node's built-in `node:sqlite`
 * (`DatabaseSync`) backs it for tests and offline validation; a production
 * `@libsql/client` (Turso / self-hosted sqld) adapter — and a Cloudflare D1
 * binding adapter — map onto the same methods. Production Lambda wiring
 * uses the HTTP-only `@libsql/client` adapter in `runtime-repositories.ts`; a
 * future Cloudflare D1 binding adapter keeps this repository contract unchanged.
 *
 * [Issue #2437] Contract notes:
 * - `all()` accepts `UPDATE … RETURNING` statements — a conditional update and
 *   its post-image (ALL_NEW equivalent) must be one statement; an update
 *   followed by a re-read opens a race window and is forbidden.
 * - `batch()` runs the statements in a **single write transaction**
 *   (all-or-nothing). A constraint violation on any statement rolls the whole
 *   batch back and rethrows the driver error.
 */
export interface SqlExecutor {
  run(sql: string, params?: readonly SqlParam[]): SqlRunResult | Promise<SqlRunResult>;
  get(sql: string, params?: readonly SqlParam[]): SqlRow | undefined | Promise<SqlRow | undefined>;
  all(sql: string, params?: readonly SqlParam[]): readonly SqlRow[] | Promise<readonly SqlRow[]>;
  batch(
    statements: readonly SqlStatement[],
  ): readonly SqlRunResult[] | Promise<readonly SqlRunResult[]>;
}
