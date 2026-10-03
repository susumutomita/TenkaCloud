/**
 * [Issue #2527 Slice 1] Disruptions aggregate — domain records, claim outcomes, and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

/** Fire API の request scope。 [Issue #2527 Slice 1 step 2] Source of truth (handler re-exports). */
export type DisruptionFireScope = "team" | "all" | "random-n";

/**
 * 1 回の disruption fire の監査行 (append-only)。 physical PK/SK は repository 層が導出する
 * (この record は最初からキーレス)。 [Issue #2527 Slice 1 step 2] Source of truth; the
 * handler module (`handlers/event-handler/disruption-types.ts`) re-exports it for
 * its API/store consumers.
 */
export interface DisruptionAuditRow {
  readonly auditId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly scope: DisruptionFireScope;
  readonly targetTeamIds: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly expiresAt: number;
  /**
   * scheduled fire で注入が実行される予定時刻 (ISO8601, UTC)。 immediate fire では
   * 未設定 (= firedAt と同時)。 audit 表示で 「N 分後に予約」 を可視化するために持つ。
   */
  readonly scheduledFor?: string;
}

// ---------------------------------------------------------------------------
// [Issue #2442] Disruptions aggregate (Issue #888).
//
// Physical shape (unchanged, `disruptions-table.ts`):
//   PK = `EVENT#<eventId>`     SK = `AUDIT#<firedAt>#<auditId>`  (append-only audit log)
//   PK = `EVENT#<eventId>`     SK = `RECUR#<requestId>`          (recurring-fire registry)
//   PK = `REQUEST#<tenantId>#<requestId>`  SK = `METADATA`       (fire idempotency claim)
//   PK = `EXEC#<requestId>#<teamId>[...]`  SK = `METADATA`       (executor at-least-once claim)
// GSI1 (`TENANT#<tenantId>` / audit+recur SK mirror) is written by every row but never queried
// by any handler today (grep-confirmed) — the DynamoDB backend still writes it (byte-identical
// Put) for forward compatibility, the SQL backend has no equivalent index. TTL = 7 days
// (`expiresAt`, epoch seconds) on every row shape.
//
// One aggregate interface spans all four row shapes (unlike CompetitorAccounts/SamlConfig,
// C2's precedent for splitting co-habiting sub-aggregates): fire/recurring/exec are different
// facets of the *same* "one fired disruption" lifecycle, always touched by the same three
// handler call chains (disruption-fire.ts → disruption-recurring.ts → executor-store.ts), so a
// single `DisruptionsRepository` mirrors how `EventsRepository` / `DeploymentsRepository`
// already span many distinct SK shapes within one aggregate.
// ---------------------------------------------------------------------------

/**
 * [Issue #2442 / Phase C3] Result of an idempotent conditional-Put claim
 * (fire idempotency `REQUEST#` row / executor `EXEC#` claim). Mirrors the
 * A2 union contract ({@link EventMutationOutcome} / {@link
 * CreateCompetitorAccountOutcome}) but uses `already` instead of `conflict`:
 * these are **at-least-once idempotency claims**, not uniqueness violations —
 * a second claim on the same key is the expected/normal shape of a retried
 * EventBridge delivery or a raced duplicate fire request, not an error
 * condition.
 */
export type DisruptionClaimOutcome =
  | { readonly outcome: "claimed" }
  | { readonly outcome: "already" };

/** [Issue #2442 / Phase C3] One page of {@link DisruptionsRepository.listAuditPage}. */
export interface DisruptionAuditPage {
  readonly items: readonly DisruptionAuditRow[];
  readonly nextCursor?: string;
}

/**
 * [Issue #2442] `EXEC#` at-least-once claim phase. `"event"` guards the
 * EventBridge-delivered fired event; `"inject"` guards the aws-scheduler delayed injection of a
 * scheduled fire; `"recurring"` guards one tick of a recurring schedule (keyed additionally by
 * `firedAt` so ticks don't collide with each other, only with their own redelivery).
 */
export type DisruptionExecutionPhase = "event" | "inject" | "recurring";

/**
 * [Issue #2442 / Phase C3] Input to {@link DisruptionsRepository.claimExecutionSlot}. The
 * physical claim key (`EXEC#<requestId>#<teamId>[#INJECT|#RECUR#<firedAt>]`) is derived
 * internally from `requestId` / `teamId` / `phase` / `firedAt` — callers never see it (mirrors
 * every other aggregate: physical-key derivation is a repository responsibility).
 */
export interface DisruptionExecutionClaimInput {
  readonly requestId: string;
  readonly teamId: string;
  readonly phase: DisruptionExecutionPhase;
  readonly disruptionId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly tenantId: string;
  readonly firedAt: string;
  readonly expiresAt: number;
}

/**
 * [Issue #2442 / Phase C3] Domain shape of one `RECUR#<requestId>` recurring-fire registry row
 * and derived 1:1 from the pre-seam `disruption-recurring.ts` Put/Get/Query
 * payload. Unlike the public {@link ActiveRecurringRow} view the operator UI reads (which omits
 * `tenantId`/`cancelledAt`), this is the full internal row: `tenantId` backs the ownership check
 * in `cancelRecurringRegistry`'s condition, `cancelledAt` backs the "still active" filter in
 * `listActiveRecurring`.
 */
export interface DisruptionRecurringRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly scope: string;
  readonly affectedTeamIds: readonly string[];
  readonly intervalMinutes: number;
  readonly maxFires: number;
  /** maxFires 回ぶん経過して自動停止する時刻 (ISO8601)。 これを過ぎた行は一覧に出さない。 */
  readonly endsAt: string;
  readonly expiresAt: number;
  /** Set by {@link DisruptionsRepository.cancelRecurringRegistry}; absent while still active. */
  readonly cancelledAt?: string;
}

/** [Issue #2442 / Phase C3] Result of {@link DisruptionsRepository.cancelRecurringRegistry}. */
export type DisruptionRecurringMutationOutcome =
  | { readonly outcome: "updated" }
  | { readonly outcome: "not_found" };

/**
 * [Issue #2442 / Phase C3] Aggregate-scoped repository for the Disruptions aggregate — domain
 * methods, not a generic key-value shim (mirror of {@link EventsRepository} /
 * {@link DeploymentsRepository}). Two interchangeable backends:
 * {@link DynamoDbDisruptionsRepository} (status quo, default) and
 * {@link SqlDisruptionsRepository} (SQLite dialect for Turso / D1, one table per row shape).
 * Selection happens at cold start via `CONTROL_DATA_BACKEND` through
 * {@link createDisruptionsRepository}.
 *
 * Every method here is a verbatim relocation of the pre-seam access `event-handler/disruption-
 * fire.ts` / `event-handler/disruption-recurring.ts` /
 * `disruption-executor-handler/executor-store.ts` /
 * `generic-scoring-handler/index.ts` already perform — no speculative API.
 */
export interface DisruptionsRepository {
  // --- Fire idempotency claim (`REQUEST#<tenantId>#<requestId>` / `METADATA`) ---
  /**
   * Conditional Put claim on the fire idempotency row, keyed by `(draft.tenantId,
   * draft.requestId)`. `already` = a prior fire already claimed this requestId (the caller
   * resolves the winner's row via {@link getFireIdempotencyRecord}); nothing is written.
   */
  claimFireIdempotency(draft: DisruptionAuditRow): Promise<DisruptionClaimOutcome>;
  /**
   * Strongly-consistent read of the fire idempotency row. `undefined` when absent, or when
   * present but not yet populated with an `auditId` (the race-winner's write is still in
   * flight) — the caller's retry loop treats both the same way.
   */
  getFireIdempotencyRecord(
    tenantId: string,
    requestId: string,
  ): Promise<DisruptionAuditRow | undefined>;

  // --- Audit log (`EVENT#<eventId>` / `AUDIT#<firedAt>#<auditId>`, append-only) ---
  /**
   * Appends one audit row. Conditioned on the physical SK being unused (ULID-collision
   * defense) — a collision propagates as an uncaught error (fail loud), matching the pre-seam
   * handler, which never caught the `ConditionalCheckFailedException` here either.
   */
  appendAudit(record: DisruptionAuditRow): Promise<void>;
  /**
   * Cursor-paginated audit history for one event, newest-first (mirrors {@link EventsPage} /
   * {@link NotificationsPage}'s opaque-cursor contract). Site: `GET
   * /events/:eventId/disruptions/audit`. Single physical page per call (verbatim relocation —
   * the pre-seam handler did not drain multiple DynamoDB pages either).
   */
  listAuditPage(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DisruptionAuditPage>;
  /**
   * Audit rows fired at/after `sinceIso`, single physical page (verbatim relocation of the
   * generic-scoring `loadOperatorEffects` query — no `maxPages` drain in the pre-seam code
   * either). Site: `generic-scoring-handler/index.ts` (active operator-fired scoring effects).
   */
  listAuditSince(eventId: string, sinceIso: string): Promise<readonly DisruptionAuditRow[]>;

  // --- Recurring-fire registry (`EVENT#<eventId>` / `RECUR#<requestId>`) ---
  /**
   * Appends one recurring-fire registry row. Conditioned on the physical SK being unused; a
   * collision propagates as an uncaught error (matches the pre-seam handler's unhandled Put).
   */
  putRecurringRegistry(record: DisruptionRecurringRecord): Promise<void>;
  /**
   * Every `RECUR#` row for an event, tenant-scoped (single physical page — verbatim relocation,
   * the pre-seam `listActiveRecurring` issued exactly one Query). The "still active" filter
   * (`!cancelledAt && endsAt > now`) stays in the caller (business logic, not data access).
   */
  listRecurringByEvent(
    eventId: string,
    tenantId: string,
  ): Promise<readonly DisruptionRecurringRecord[]>;
  /** Point read of one recurring registry row. `undefined` when absent. */
  getRecurringRegistry(
    eventId: string,
    requestId: string,
  ): Promise<DisruptionRecurringRecord | undefined>;
  /**
   * Stamps `cancelledAt`, conditioned on `tenantId` ownership. `not_found` covers both "row
   * absent" and "tenant mismatch" (never leaks another tenant's row, same convention as
   * {@link CompetitorAccountMutationOutcome}).
   */
  cancelRecurringRegistry(
    eventId: string,
    requestId: string,
    tenantId: string,
    cancelledAt: string,
  ): Promise<DisruptionRecurringMutationOutcome>;

  // --- Executor at-least-once claim (`EXEC#<requestId>#<teamId>[...]` / `METADATA`) ---
  /**
   * Conditional Put claim on one executor execution slot (per-team, per-phase). `already` =
   * this delivery was already processed (at-least-once redelivery); nothing is written.
   */
  claimExecutionSlot(input: DisruptionExecutionClaimInput): Promise<DisruptionClaimOutcome>;

  /**
   * TTL-equivalent sweep for SQL backends (mirrors {@link EventsRepository.pruneExpired} /
   * {@link TeamsRepository.pruneExpired} / {@link NotificationsRepository.pruneExpired}).
   * DynamoDB has native TTL on `expiresAt`; the SQLite backends have none and
   * rely on this being run on a schedule. Sweeps every row shape (audit / fire-claim /
   * recurring / exec-claim).
   */
  pruneExpired(nowEpochSeconds: number): Promise<number>;
}
