/**
 * [Issue #2527 Slice 1] Events aggregate — domain records, mutation outcomes, and repository port.
 *
 * Extracted verbatim from the former all-aggregate `control-data/types.ts` so each
 * aggregate's domain contract lives in its own module. `../types.ts` re-exports this
 * module as a temporary compatibility barrel while consumers migrate to direct imports.
 */

import type { TeamRecord } from "./teams.js";

/**
 * [Issue #2527 Slice 1 step 2] Event lifecycle status — the domain union is the
 * source of truth; the request-validation Zod enum in
 * `handlers/event-handler/types.ts` (`EventStatusSchema`) is compile-time locked
 * to this union.
 */
export type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";

/**
 * Event 内の 1 問題ごとの deploy target。region は問題テンプレが特定 region 依存の場合が
 * あるため **problem 単位** で固定。AWS Account ID は #528 以降 **team 単位** に移行する
 * (= 各 team は自社 AWS account で全問題を deploy する運用モデル)。
 *
 * `defaultAwsAccountId` は migration 期間中 optional に保つ:
 *   - 新規 Event: 不要 (= team.awsAccountId を使う)
 *   - 旧 Event: 既存値を fallback として使う (bulk-deploy.ts の `team.awsAccountId ??`)
 *
 * [Issue #2527 Slice 1 step 2] Source of truth; the validation schema
 * (`handlers/event-handler/types.ts`'s `EventProblemTargetSchema`, which owns the
 * problemId / account / region regexes) is compile-time locked to this shape.
 */
export type EventProblemTarget = {
  problemId: string;
  /** @deprecated #528 で team 単位 (team.awsAccountId) に移行。旧 Event の fallback としてのみ残す */
  defaultAwsAccountId?: string;
  defaultRegion: string;
};

/** Progression Gate (#2283) の team 単位ポリシー。 `required` = Gate 完了まで lock、 `off` = bypass。 */
export type ProgressionGateTeamPolicy = "required" | "off";

/**
 * team 単位の上書き。
 *   - `required`: Gate 完了まで unlock target を開始できない
 *   - `off`: この team は Gate を bypass (= 最初から全問題)
 *   - `completionBonus`: Gate 完了時に 1 度だけ付与する固定ボーナス (省略時 0)
 */
export type ProgressionGateTeamOverride = {
  policy: ProgressionGateTeamPolicy;
  completionBonus?: number;
};

/**
 * Event 1 件の Gate 設定 (= `PUT /events/:eventId/progression-gate` body / EventRecord 保存 shape)。
 *
 * 初期実装は 「1 つの Gate challenge を起点に指定 target を unlock」 の単一 Gate モデル
 * (複数 Gate / 分岐ルートは Issue #2283 の将来拡張)。
 *
 * [Issue #2527 Slice 1 step 2] Source of truth; the validation schema with the
 * self-reference / uniqueness refinements stays in
 * `handlers/shared/progression-gate.ts` (`ProgressionGateConfigSchema`) and is
 * compile-time locked to this shape.
 */
export type ProgressionGateConfig = {
  gateProblemId: string;
  unlockTargetIds: string[];
  defaultPolicy: ProgressionGateTeamPolicy;
  teamOverrides?: Record<string, ProgressionGateTeamOverride>;
};

/**
 * Control-plane data behind a repository seam.
 *
 * `EventRecord` is the domain shape of one competition Event. Physical DDB keys
 * (PK / SK / GSI1PK / GSI1SK) are an implementation detail of the DynamoDB
 * backend; the SQLite backends (Turso / D1) derive their own keys / columns.
 *
 * [Issue #2527 Slice 1 step 2] Source of truth: the physical row
 * (`handlers/event-handler/types.ts`'s `EventItem`) derives from this record by
 * adding the physical keys — a new event attribute is added HERE and flows to
 * the handler layer, never the reverse.
 */
export type EventRecord = {
  eventId: string;
  tenantId: string;
  name: string;
  status: EventStatus;
  problems: EventProblemTarget[];
  teamCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  /**
   * [Problem Packs / Issue #2464] Deterministic id of the active catalog snapshot
   * pinned when this event was created. Present only when the active catalog has
   * at least one pack-sourced problem; core-only events omit it to keep the
   * legacy row shape byte-identical.
   */
  catalogSnapshotId?: string;
  /**
   * [Problem Packs / Issue #2464] Pack-sourced provenance pinned at event creation,
   * keyed by problem id. Core problems are intentionally absent (`undefined` =
   * core); this field is omitted entirely when the active catalog has no pack rows.
   */
  packProvenance?: Record<string, { packId: string; packVersion: string; contentDigest: string }>;
  /**
   * 競技開始時刻 (ISO8601, UTC)。これより前は HealthCheckLambda が probe / 採点を skip。
   * 未設定なら採点は始まらない (= deploy 直後に勝手にスコアが加算されるのを防ぐ)。
   * 値は分精度想定 (operator UI が DatePicker + TimeInput で入力)。
   */
  startsAt?: string;
  /**
   * 競技終了時刻 (ISO8601, UTC)。これ以降は HealthCheckLambda が probe / 採点を skip。
   * operator が「Event を終了」 button を押した時点で `now()` が書かれ、status も
   * `ENDED` に遷移する。Bulk Teardown 待たずに採点を停めるための gate (Issue #494)。
   */
  endsAt?: string;
  /**
   * 自動撤去予定時刻 (ISO8601, UTC)。毎分 reconciler が `now >= teardownAt` を
   * 検知すると bulk teardown を自動発火し、撤去し忘れによる課金リークを防ぐ (#1910 の主動機)。
   * 不変条件: 設定する場合 `teardownAt >= endsAt` (採点 gate を閉じてから撤去する)。
   * 未設定なら自動撤去なし (= operator が手動で「Event を終了」/ teardown する従来挙動)。
   */
  teardownAt?: string;
  /**
   * reconciler が teardownAt に基づき自動 teardown を発火した時刻 (ISO8601, UTC)。
   * status 遷移 (→ TEARDOWN) が一次の冪等ガードだが、監査 + 二重発火防止の補助として記録する。
   */
  teardownFiredAt?: string;
  /**
   * 自動デプロイ予定時刻 (ISO8601, UTC)。毎分 reconciler が `now >= deployAt`
   * を検知すると、 status=DRAFT の event について bulk deploy を自動発火し、 deploy のし忘れ /
   * 開始時刻直前の手動操作を不要にする (teardownAt の鏡像)。 不変条件: 設定する場合
   * `deployAt <= endsAt` (deploy → 採点 → 終了 の時系列を保つ)。 未設定なら自動デプロイなし
   * (= operator が手動で「Deploy」を押す従来挙動)。
   */
  deployAt?: string;
  /**
   * reconciler が deployAt に基づき自動 deploy を発火した時刻 (ISO8601, UTC)。
   * status 遷移 (DRAFT → DEPLOYING) が一次の冪等ガードだが、監査 + 二重発火防止の補助として記録する
   * (teardownFiredAt の鏡像)。
   */
  deployFiredAt?: string;
  /**
   * Archive 操作で `status=ARCHIVED` に遷移した時刻 (ISO 8601, UTC)。Issue #493。
   * EventList が ARCHIVED を default view から外すときの sort key としても使える。
   */
  archivedAt?: string;
  /**
   * 採点 lock flag (#558)。`true` のとき:
   *   - HealthCheck Lambda は uptime 加点 / probe を skip
   *   - submit-flag handler は `scoring_locked` outcome を返し score 不変
   *   - leaderboard / score-events の read は許可 (= 表彰画面で最終 score を見せる)
   * status (DRAFT/.../ARCHIVED) と直交する軸として持つ (`status=READY (locked)` 等の合成)。
   * reversible — operator が表彰中に bug 発見した場合 unlock 可能。
   */
  scoringLocked?: boolean;
  /** scoringLocked を true にした時刻 (ISO 8601, UTC)。unlock 時は undefined に戻す。 */
  scoringLockedAt?: string;
  /** scoringLocked を変更した operator の Cognito sub (= audit 用)。 */
  scoringLockedBy?: string;
  /**
   * Issue #1038 P1 #9 follow-up: scoreboard freeze window 分数 (= 終了 N 分前から順位を隠す)。
   * 0 で freeze 無効化、 1〜180 が想定範囲。 未設定なら participant-handler 側 default=30 が
   * 効く ([[participant-handler/leaderboard.ts:DEFAULT_FREEZE_MINUTES]])。
   */
  scoreboardFreezeMinutes?: number;
  /**
   * Issue #2283: Progression Gate (問題アンロック / チーム別ハンデ) 設定。
   * `PUT /events/:eventId/progression-gate` で保存 / `DELETE` で除去。 未設定 = Gate 無し
   * (= 従来どおり全問題を開始可能)。 enforcement は per-tenant feature flag
   * `challengePrerequisiteGate` (既定 OFF) が ON のときだけ有効 — 設定が残っていても
   * flag OFF なら participant / scoring 側は無視するので、 進行中 Event でも flag OFF 切替で
   * 即 unlock される。 validation schema は `handlers/shared/progression-gate.ts`。
   */
  progressionGate?: ProgressionGateConfig;
};

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
 * `teardownFiredAt`, `deploy` → `deployFiredAt`.
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
 * Aggregate-scoped repository for the Events aggregate — domain
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
   * has native TTL; the SQLite backends have none and rely on this
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
   * [#536 / #537] Partial schedule update — writes only the fields
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
   * Idempotently stamps `teardownFiredAt` / `deployFiredAt` = `at`
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
