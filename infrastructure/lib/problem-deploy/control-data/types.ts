import type {
  CompositeParentDeploymentItem,
  CompositeTargetDeploymentItem,
} from "../handlers/deploy-handler/composite-deployment.js";
import type {
  DeploymentItem,
  DeploymentStatus,
  HintRevealRecord,
} from "../handlers/deploy-handler/types.js";
import type { EventItem, TeamItem } from "../handlers/event-handler/types.js";
import type { NotificationItem } from "../handlers/shared/notification.js";
import type { ProgressionGateConfig } from "../handlers/shared/progression-gate.js";
import type { ScoreEventItem } from "../handlers/shared/score-event.js";
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
  /**
   * TTL-equivalent sweep for SQL backends. DynamoDB has native TTL, but exposes
   * the same defensive manual sweep as Events / Teams so the pure-SQL runtime can
   * prune all expiring aggregates from one reconciler tick.
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}

/** [#2439] TenantFeatureFlags の domain shape(tenantId / flags / updatedAt / updatedBy)。 */
export type TenantFeatureFlagsRecord = Omit<TenantFeatureFlagsItem, "PK" | "SK">;

/**
 * TenantFeatureFlags has no TTL / expiresAt attribute, so it intentionally does
 * not expose `pruneExpired`; manual prune covers only Events / Teams /
 * Notifications.
 */
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
export type ControlDataBackend = "dynamodb" | "turso" | "sql" | "turso-mirror" | "sql-mirror";

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

// ---------------------------------------------------------------------------
// [Issue #2441 / Phase B1] Deployments aggregate — READ seam.
//
// The Deployments table carries three GSIs and is (per the #2441 inventory) the
// single largest standing DynamoDB cost. This seam extracts the READ access the
// six handler groups already perform, verbatim, so a future SQL backend can
// stand in behind the same domain methods. B1 is read-only: conditional /
// atomic writes (B2/B3), the base-table Scans (B3), and the SQL implementation
// itself (B4) are separate PRs. The DynamoDB backend keeps every
// KeyCondition / Filter / Projection / placeholder / Limit / ScanIndexForward
// byte-identical to the pre-seam handler code — B1 is a pure NO-OP relocation.
// ---------------------------------------------------------------------------

/**
 * [Issue #2441 / Phase B1] The domain shape of one deployment META row, derived
 * from the canonical DynamoDB row (`DeploymentItem`) minus its physical DDB keys
 * (base PK/SK plus GSI1/GSI2/GSI3 — GSI3 lives on composite target rows only,
 * `Omit` is a no-op for the keys `DeploymentItem` does not declare). Those keys
 * are an implementation detail of the DynamoDB backend; the SQLite backend (B4)
 * derives its own keys / columns. Deriving from `DeploymentItem` keeps this
 * shape in lock-step with the handler layer.
 *
 * `teamLoginKey` stays on the record in B1 (verbatim relocation). The SHA-256
 * hashing of the participant bearer for the SQL index is a B4 concern, exactly
 * as the Teams seam handled it (#2290) — not a B1 read-path change.
 */
export type DeploymentRecord = Omit<
  DeploymentItem,
  "PK" | "SK" | "GSI1PK" | "GSI1SK" | "GSI2PK" | "GSI2SK" | "GSI3PK" | "GSI3SK"
>;

export type CompositeParentDeploymentRecord = Omit<CompositeParentDeploymentItem, "PK" | "SK">;

export type CompositeTargetDeploymentRecord = Omit<
  CompositeTargetDeploymentItem,
  "PK" | "SK" | "GSI3PK" | "GSI3SK"
>;

/**
 * [Issue #2441 / Phase B2] Result of one conditional Deployment mutation. Mirrors
 * {@link EventMutationOutcome}: DynamoDB CCFs stay inside the seam, and methods
 * only carry `record` when the pre-seam write returned a post-image or explicitly
 * probed after a condition failure.
 */
export type DeploymentMutationOutcome =
  | { readonly outcome: "updated"; readonly record?: DeploymentRecord }
  | { readonly outcome: "conflict"; readonly record?: DeploymentRecord }
  | { readonly outcome: "not_found" };

export interface DeploymentKindScoringResult {
  readonly scoreDelta: number;
  readonly lastResult?: DeploymentRecord["lastResult"];
  readonly endpointsHealthJson?: string;
  readonly attackProbesJson?: string;
  readonly postureJson?: string;
  readonly platform?: string;
  readonly newState?: unknown;
}

export interface DeploymentSchedulePatch {
  readonly startsAt?: string;
  readonly endsAt?: string;
}

export interface BulkDeploymentCreateEntry {
  readonly record: DeploymentRecord;
  readonly replacesJobId?: string;
}

/**
 * [Issue #2441 / Phase B1] The domain shape of one `EVENT#<isoTs>#<ulid>` score
 * event row (the sparse scoring-history sub-aggregate that co-habits the
 * `DEPLOYMENT#<jobId>` partition), derived from `ScoreEventItem` minus its
 * physical base PK/SK. Written by `shared/score-event.ts`; read by the four
 * timeline sites (battle-attacks / score-events / leaderboard-score-events /
 * team-score-events).
 */
export type ScoreEventRecord = Omit<ScoreEventItem, "PK" | "SK">;

/**
 * [Issue #2441 / Phase B1] The domain shape of one `INBOX#<isoTs>#<ulid>`
 * inter-team cast/inbox row (ADR-028 D3 / #1420) — a second sparse sub-aggregate
 * in the `DEPLOYMENT#<jobId>` partition, distinct from score events. Written and
 * read by `participant-handler/cast-event.ts`. The base PK/SK are stripped as in
 * every other record here.
 */
export interface InboxEventRecord {
  readonly eventId?: string;
  readonly fromTeamId?: string;
  readonly fromJobId?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly occurredAt?: string;
  readonly ttl?: number;
}

/**
 * [Issue #2441 / Phase B1] The domain shape of the per-event inter-team
 * coordination state (`COORD#<tenantId>#<eventId>` / SK `STATE`, ADR-028 D3).
 * Mirrors the pre-seam `CoordinationStateRow` (`coordination-store.ts`): the
 * opaque plugin `state` plus its optimistic-lock `version` (0 when the row is
 * absent). The version predicate write is B2/B3 (conditional-write seam).
 */
export interface CoordinationStateRecord {
  readonly state: unknown;
  readonly version: number;
}

/**
 * [Issue #2441 / Phase B1] One page of {@link DeploymentsRepository.listByTenantPage}.
 * `nextCursor` is an **opaque** token — the pre-seam `list.ts` cursor codec
 * (base64url `ExclusiveStartKey`, allowlist `PK/SK/GSI1PK/GSI1SK/GSI2PK/GSI2SK`),
 * byte-identical wire format so a cursor already handed to a UI mid-pagination
 * stays valid. Callers must not decode it themselves.
 */
export interface DeploymentsPage {
  readonly items: readonly DeploymentRecord[];
  readonly nextCursor?: string;
}

/**
 * [Issue #2441 / Phase B1] Aggregate-scoped **read** repository for the
 * Deployments aggregate — domain methods, not a generic key-value shim (mirror
 * of {@link EventsRepository} / {@link TeamsRepository}). Only the DynamoDB
 * backend exists in B1 ({@link DynamoDbDeploymentsRepository}); `turso` / `sql`
 * fail loudly through {@link createDeploymentsRepository} until B4 lands the SQL
 * implementation.
 *
 * Fixed contract for every method:
 *  - The DynamoDB request (KeyCondition / Filter / Projection / placeholder
 *    names / Limit / ScanIndexForward) is a **verbatim** relocation of the named
 *    pre-seam site — B1 changes zero request bytes.
 *  - Full-page drain (the `ddb-paginate` helpers / the inline `event-handler`
 *    loop) is absorbed as an internal responsibility; the `maxPages` bound of a
 *    bounded drain survives as a method argument.
 *  - Projection-bearing queries narrow their return to a `Pick<DeploymentRecord,
 *    …>` (byte-compat AND type-honesty). A projection that carries the physical
 *    `PK` returns the domain `jobId` (derived from `DEPLOYMENT#<jobId>`) instead
 *    — the seam never leaks a physical key.
 *  - `getDeployment` / `queryDeploymentMeta` return the raw row without a tenant
 *    check: the pre-seam sites 404-fold cross-tenant reads in the caller, so the
 *    tenant predicate deliberately stays there (unchanged behavior).
 */
export interface DeploymentsRepository {
  /**
   * META point read via `GetItem` (`PK = DEPLOYMENT#<jobId>`, `SK = META`).
   * Sites: `deploy-handler/{retry,delete,list,stack-progress}` + composite
   * `getRawRow`. The tenant / status guards stay in the caller (raw read).
   */
  getDeployment(jobId: string): Promise<DeploymentRecord | undefined>;
  /**
   * META read via `Query` (`PK = :pk AND SK = :sk`) — the ONE site
   * (`participant-handler/cast-event.ts`) that reads the META row with a Query
   * rather than a GetItem. Kept as its own method so the wire call (Query, not
   * Get) stays byte-identical; folding it into {@link getDeployment} would swap
   * the DynamoDB command.
   */
  queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined>;

  /**
   * One GSI1 page for a tenant, newest-first (`GSI1PK = TENANT#<id>`,
   * `ScanIndexForward=false`, `Limit`, opaque cursor). Site:
   * `deploy-handler/list.ts` `listDeployments`. The `problemId` in-memory filter
   * and the DEFAULT/MAX limit clamp stay in the caller.
   */
  listByTenantPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DeploymentsPage>;
  /**
   * Active-deployment count for a tenant (`Select=COUNT`, `FilterExpression`
   * `#s IN (…)` built from `activeStatuses`, full-page drain). Site:
   * `deploy-handler/deploy-quota.ts`. `opts.stopAtCount` preserves the pre-seam
   * early-break (stop paging once the running count reaches the quota — the
   * caller only needs the `>= limit` decision, so a capped count suffices).
   */
  countActiveByTenant(
    tenantId: string,
    activeStatuses: readonly string[],
    opts?: { readonly stopAtCount?: number },
  ): Promise<number>;
  /**
   * Every deployment for a `(tenant, event)` pair (GSI1 + `FilterExpression`
   * `eventId = :ev`, full-page drain, full record). Sites:
   * `participant-handler/{leaderboard,leaderboard-score-events}` +
   * `event-handler/shared.ts` `queryDeploymentsByEvent` (no-projection caller).
   * The drain is the #1797 / #1815 correctness fix — folded in here.
   */
  listByTenantAndEvent(tenantId: string, eventId: string): Promise<readonly DeploymentRecord[]>;
  /**
   * Deployment `jobId`s for a `(tenant, event)` pair (GSI1 + `FilterExpression`
   * `eventId = :ev` + `ProjectionExpression "PK"`, full-page drain). Site:
   * `event-handler/shared.ts` `queryDeploymentsByEvent` called with `"PK"`
   * (`end-event` / `schedule` propagation). Returns the domain `jobId` derived
   * from the projected `PK`.
   */
  listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]>;
  /**
   * Reconciler view of a `(tenant, event)` pair (GSI1 + `FilterExpression`
   * `eventId = :ev` + `ProjectionExpression "PK, #status, updatedAt"`, full-page
   * drain). Site: `generic-scoring-handler/event-reconciler.ts`. `jobId` is
   * derived from the projected `PK`.
   */
  listReconcilerRowsByEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly Pick<DeploymentRecord, "jobId" | "status" | "updatedAt">[]>;
  /**
   * The COMPLETE deployment(s) for a fired `(tenant, event, team, problem)`
   * disruption (GSI1 + `FilterExpression` `eventId = :ev AND teamId = :tid AND
   * problemId = :pid`, full-page drain). Site:
   * `disruption-executor-handler/executor-store.ts`. The COMPLETE / cross-account
   * selection stays in the caller.
   */
  listByEventTeamProblem(
    tenantId: string,
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly DeploymentRecord[]>;
  /**
   * Non-terminal rows sharing a `namePrefix` for a tenant (GSI1 +
   * `FilterExpression` `namePrefix = :np` + `ProjectionExpression
   * "namePrefix, jobId, #s"`, full-page drain). Site:
   * `deploy-handler/cloud-action-enforcement.ts`. The self-exclusion + status
   * classification stay in the caller.
   */
  findByNamePrefix(
    tenantId: string,
    namePrefix: string,
  ): Promise<readonly Pick<DeploymentRecord, "namePrefix" | "jobId" | "status">[]>;
  /**
   * Admin per-event detail summaries for a tenant (GSI1, no filter,
   * `ProjectionExpression "PK, teamId, eventId, displayTeamName, teamName,
   * problemId, jobId, #s"`, **single page** — the pre-seam
   * `event-handler/list.ts` `getEventDetail` issues one Query, no drain). The
   * eventId in-memory grouping stays in the caller.
   */
  listDeploymentSummariesByTenant(
    tenantId: string,
  ): Promise<
    readonly Pick<
      DeploymentRecord,
      "jobId" | "teamId" | "eventId" | "displayTeamName" | "teamName" | "problemId" | "status"
    >[]
  >;

  /**
   * Participant bearer lookup by `teamLoginKey` (GSI2 `TEAMKEY#<key>`, sparse,
   * single page). Sites: `participant-handler/shared.ts` `queryTeamItems` (the
   * participant-login source of truth) + `generic-scoring-handler/gate-completion-bonus.ts`.
   * Byte-compat is the top priority here — this is the participant login path.
   */
  listByTeamLoginKey(teamLoginKey: string): Promise<readonly DeploymentRecord[]>;

  /**
   * A composite parent's target rows (GSI3 `PARENT_DEPLOYMENT#<id>`,
   * `ScanIndexForward=true` = declared order, single page). Site:
   * `deploy-handler/composite-repository.ts`. The `isCompositeTargetItem` filter
   * stays in the caller (the sparse GSI3 already scopes to target rows).
   */
  listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]>;

  /**
   * A deployment's score-event history (`PK = DEPLOYMENT#<jobId> AND
   * begins_with(SK, "EVENT#")`, `ScanIndexForward=false`, `Limit=pageSize`,
   * bounded to `opts.maxPages` pages — omit `maxPages` to drain fully). Sites:
   * `participant-handler/{score-events,leaderboard-score-events}` +
   * `event-handler/team-score-events.ts`. The `toView` domain filter + the
   * final truncate stay in the caller.
   */
  listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]>;
  /**
   * A deployment's score events over an SK range (`PK = :pk AND SK BETWEEN
   * :sk_start AND :sk_end`, `ScanIndexForward=false`, full-page drain). Site:
   * `participant-handler/battle-attacks.ts` (EVENT# timeline window). The
   * caller builds the `EVENT#<iso>` / `EVENT#~` bounds and applies its
   * `source` filter.
   */
  listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]>;
  /**
   * A deployment's inbox events over an SK range — the byte-identical
   * `SK BETWEEN` query as {@link listScoreEventsInRange} (shared internally), but
   * over the `INBOX#` sub-aggregate, so its return is the honest
   * {@link InboxEventRecord}. Site: `participant-handler/cast-event.ts`
   * `queryInboxRows`.
   */
  listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]>;

  /**
   * The per-event inter-team coordination state (`GetItem`
   * `PK = COORD#<tenantId>#<eventId>`, `SK = STATE`). Returns `undefined` when
   * the row is absent (= uninitialized). Site:
   * `participant-handler/coordination-store.ts` `readCoordinationState`.
   */
  readCoordinationState(
    tenantId: string,
    eventId: string,
  ): Promise<CoordinationStateRecord | undefined>;

  // ---------------------------------------------------------------------------
  // [Issue #2441 / Phase B3] Full-table Scans, per-page callback. Unlike the
  // GSI1/GSI2/GSI3 `list*` reads above (which drain internally and return every
  // row), these mirror `handlers/shared/ddb-paginate.ts`'s `forEachScanPage`:
  // the caller supplies `onPage`, and the backend invokes it once per physical
  // page so per-page fan-out (BatchGet / bounded `Promise.all`) stays intact —
  // collecting every row into memory first would change that fan-out width.
  // Every FilterExpression / ProjectionExpression / Limit is a verbatim
  // relocation of the named pre-seam site.
  // ---------------------------------------------------------------------------

  /**
   * Every `status=COMPLETE` deployment, optionally scoped to one `eventId`
   * (`FilterExpression` `#status = :complete [AND eventId = :eventId]`,
   * `Limit=200`). Site: `generic-scoring-handler/index.ts` (the scoring-tick
   * dispatch scan). `eventId === undefined` runs the unscoped (global tick)
   * variant; the caller's own `eventId` equality re-check (confused-deputy
   * guard for mocks / malformed rows) stays in the caller.
   */
  forEachCompleteDeploymentPage(
    eventId: string | undefined,
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void>;
  /**
   * Composite parent rows in a non-terminal deploy-phase status
   * (`FilterExpression` `runtimeKind = :composite AND #s IN (:p, :i)` fixed to
   * `PENDING`/`IN_PROGRESS`, `Limit=200`). Site:
   * `generic-scoring-handler/composite-status-reconciler.ts`
   * `reconcileCompositeParents`.
   */
  forEachCompositeDeployReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void>;
  /**
   * Composite parent rows currently `DELETING` (`FilterExpression`
   * `runtimeKind = :composite AND #s = :deleting`, `Limit=200`). Site:
   * `generic-scoring-handler/composite-teardown-reconciler.ts`
   * `reconcileCompositeParentTeardowns`. A distinct method from
   * {@link forEachCompositeDeployReconcilablePage} because the FilterExpression
   * differs (`=` vs `IN`), per the seam's one-method-per-expression rule.
   */
  forEachCompositeTeardownPendingPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void>;
  /**
   * Active non-AWS runtime rows (`FilterExpression`
   * `attribute_exists(runtimeProvider) AND #s IN (:p, :i, :c, :d)` fixed to
   * `PENDING`/`IN_PROGRESS`/`COMPLETE`/`DELETING`, `Limit=200`). Site:
   * `generic-scoring-handler/runtime-status-reconciler.ts`
   * `reconcileRuntimeStatuses`.
   */
  forEachRuntimeReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void>;
  /**
   * COMPLETE deployments for one `eventId` with a team score
   * (`FilterExpression` `#status = :complete AND eventId = :eventId AND
   * attribute_exists(teamId) AND attribute_exists(score)`,
   * `ProjectionExpression "eventId, teamId, problemId, score"`,
   * `ConsistentRead=true`, `Limit=200`). Site:
   * `generic-scoring-handler/runtime-score-feed.ts` `publishRuntimeScoreFeed`.
   */
  forEachRuntimeScoreFeedPage(
    eventId: string,
    onPage: (
      items: readonly Pick<DeploymentRecord, "eventId" | "teamId" | "problemId" | "score">[],
    ) => Promise<void>,
  ): Promise<void>;

  // ---------------------------------------------------------------------------
  // [Issue #2441 / Phase B2] Conditional/atomic writes. Every DynamoDB
  // UpdateExpression / ConditionExpression lives in the backend verbatim; callers
  // consume outcome data instead of catching backend-specific CCF exceptions.
  // ---------------------------------------------------------------------------

  putDeployment(record: DeploymentRecord): Promise<void>;
  /**
   * DeployCreate SFN `MarkInProgress`: unconditional `SET #status = :status,
   * updatedAt = :updatedAt`. It intentionally has no tenant/status condition so
   * SFN task retries rewrite the same state instead of branching on a CCF.
   */
  markCreateInProgress(jobId: string, at: string): Promise<DeploymentMutationOutcome>;
  /**
   * DeployCreate SFN `MarkSucceeded` / `MarkSucceededWithoutBuildId`: writes
   * COMPLETE plus stack metadata. `buildId` is omitted on the Lambda deploy path
   * and must not clear an existing attribute, matching the SFN UpdateExpression.
   */
  markCreateSucceeded(
    jobId: string,
    stackId: string,
    stackOutputs: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  /**
   * DeployCreate SFN `MarkFailed` / `MarkFailedWithoutBuildId`: writes FAILED
   * plus the failure reason. `buildId` follows the same optional semantics as
   * {@link markCreateSucceeded}.
   */
  markCreateFailed(
    jobId: string,
    failureReason: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;
  retryToPending(jobId: string, tenantId: string, at: string): Promise<DeploymentMutationOutcome>;
  compensateRetryToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;
  markDeleting(
    jobId: string,
    tenantId: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;
  compensateDeleteToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;
  markApprovalPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome>;
  putCompositeParent(record: CompositeParentDeploymentRecord): Promise<DeploymentMutationOutcome>;
  putCompositeTarget(record: CompositeTargetDeploymentRecord): Promise<DeploymentMutationOutcome>;

  applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  applyHintPenalty(
    jobId: string,
    hint: HintRevealRecord,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  casCompositeParentStatus(
    jobId: string,
    previousStatus: DeploymentStatus,
    nextStatus: DeploymentStatus,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome>;
  awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  setScoringState(jobId: string, stateJson: string, at: string): Promise<DeploymentMutationOutcome>;
  markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: DeploymentStatus,
    nextStatus: DeploymentStatus,
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  compensateBulkTeardown(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  markDeletingForBulk(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  applySchedulePatch(
    jobId: string,
    tenantId: string,
    patch: DeploymentSchedulePatch,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  createBulkDeployments(
    tenantId: string,
    entries: readonly BulkDeploymentCreateEntry[],
  ): Promise<DeploymentMutationOutcome>;
  compensateBulkCreateToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
  stampEventEndsAt(
    jobId: string,
    tenantId: string,
    endsAt: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  // ---------------------------------------------------------------------------
  // [Issue #2441 / Phase B3] Sub-aggregate writes (verbatim Puts / conditional
  // Put moved from `handlers/shared/`).
  // ---------------------------------------------------------------------------

  /**
   * Appends one score-event row (`PK = DEPLOYMENT#<jobId>`, `SK =
   * EVENT#<occurredAt>#<ulid>` — the physical SK is derived here, never
   * supplied by the caller). Site: `handlers/shared/score-event.ts`
   * `writeScoreEvent` (callers: `apply-kind-result.ts` / `submit-flag.ts` /
   * `reveal-hint.ts`).
   */
  appendScoreEvent(record: ScoreEventRecord): Promise<void>;
  /**
   * Appends one inter-team inbox row (`PK = DEPLOYMENT#<jobId>`, `SK =
   * INBOX#<occurredAt>#<inboxId>`). `jobId` is the **target** deployment (the
   * recipient's partition); `inboxId` is the caller-generated ulid that also
   * becomes the domain-visible cast-event id. Site:
   * `participant-handler/cast-event.ts` `castEvent`.
   */
  appendInboxEvent(jobId: string, inboxId: string, record: InboxEventRecord): Promise<void>;
  /**
   * Optimistic-lock write of the per-event coordination state (`PutItem`,
   * `ConditionExpression "attribute_not_exists(version) OR version =
   * :expected"`, `version` set to `expectedVersion + 1`). Mirrors the A2/B2
   * union contract: `conflict` folds the DynamoDB `ConditionalCheckFailed`
   * instead of throwing (never `not_found` — a first write creates the row).
   * Site: `participant-handler/coordination-store.ts` `writeCoordinationState`.
   */
  writeCoordinationState(
    tenantId: string,
    eventId: string,
    state: unknown,
    expectedVersion: number,
    at: string,
  ): Promise<DeploymentMutationOutcome>;
}
