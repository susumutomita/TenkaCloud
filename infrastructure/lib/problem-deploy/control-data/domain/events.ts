/**
 * [Issue #2527 Slice 1] Events aggregate — domain records, mutation outcomes, and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

import type { EventItem } from "../../handlers/event-handler/types.js";
import type { ProgressionGateConfig } from "../../handlers/shared/progression-gate.js";
import type { TeamRecord } from "./teams.js";

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
