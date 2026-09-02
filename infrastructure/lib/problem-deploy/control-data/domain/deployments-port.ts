/**
 * [Issue #2527 Slice 1] Deployments aggregate — the repository port.
 *
 * Split from `./deployments.ts` (the record shapes) so each file carries one
 * responsibility. This is still the FAT all-capability interface the #2527
 * inventory flagged; Slice 2 decomposes it into capability ports (query/read,
 * lifecycle commands, scoring/inbox, composite, coordination) — keep new
 * methods out of here and put them on the right capability port once Slice 2
 * lands.
 */

import type { CoordinationRunKey, CoordinationRunPointer } from "./coordination-run.js";
import type { CoordinationStateScope } from "./coordination-scope.js";
import type {
  BulkDeploymentCreateEntry,
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  CoordinationStateRecord,
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentStatus,
  DeploymentsPage,
  HintRevealRecord,
  InboxEventRecord,
  ScoreEventRecord,
} from "./deployments.js";

/**
 * [Issue #2527 Slice 2] Query/read capability of the Deployments aggregate —
 * point reads, GSI listings, projections, and the full-table Scans the
 * reconcilers drive. Every DynamoDB request stays a verbatim relocation of its
 * named pre-seam site (KeyCondition / Filter / Projection / Limit /
 * ScanIndexForward byte-identical; #2441 B1/B3).
 *
 * The `forEach*Page` scans mirror `handlers/shared/ddb-paginate.ts`'s
 * `forEachScanPage`: the caller supplies `onPage`, and the backend invokes it
 * once per physical page so per-page fan-out (BatchGet / bounded `Promise.all`)
 * stays intact — collecting every row into memory first would change that
 * fan-out width.
 */
export interface DeploymentsQueryPort {
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
   * [Issue #2946] Deployments for this tenant that **ever reached `COMPLETE`**,
   * counted by the presence of the `completedAt` marker rather than by current
   * `status`.
   *
   * Current status cannot answer this. A successful deployment is torn down to
   * `DELETING` → `DELETED` / `EXPIRED` / `AUTO_DELETED`, and a FAILED one can
   * reach `DELETED` through the same teardown path, so `DELETED` covers both
   * "succeeded then removed" and "failed then removed".
   *
   * Rows written before the marker existed have no `completedAt`, so this count
   * is **not retroactive**. Callers must not present it as "this tenant has
   * succeeded 0 times" for a tenant whose deployments all predate the marker —
   * see `everCompletedDeploysCoverage` on the summary.
   */
  countEverCompletedByTenant(tenantId: string): Promise<number>;

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

  // [Issue #2441 / Phase B3] Full-table Scans, per-page callback. Unlike the
  // GSI1/GSI2/GSI3 `list*` reads above (which drain internally and return every
  // row), these mirror `handlers/shared/ddb-paginate.ts`'s `forEachScanPage`:
  // the caller supplies `onPage`, and the backend invokes it once per physical
  // page so per-page fan-out (BatchGet / bounded `Promise.all`) stays intact —
  // collecting every row into memory first would change that fan-out width.
  // Every FilterExpression / ProjectionExpression / Limit is a verbatim
  // relocation of the named pre-seam site.

  /**
   * Every `status=COMPLETE` deployment, optionally scoped to one `eventId`
   * (`FilterExpression` `#status = :complete [AND eventId = :eventId]`,
   * `Limit=200`). Site: `generic-scoring-handler/index.ts` (the scoring-tick
   * dispatch scan). `eventId === undefined` runs the unscoped (global tick)
   * variant; the caller's own `eventId` equality re-check (confused-deputy
   * guard for mocks / malformed rows) stays in the caller.
   */
  forEachCompleteDeploymentPage(
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
}

/**
 * [Issue #2527 Slice 2] Deploy lifecycle commands — creation, SFN status
 * writebacks, retry/delete compensations, bulk create/teardown, and schedule
 * propagation. Every DynamoDB UpdateExpression / ConditionExpression lives in
 * the backend verbatim; callers consume {@link DeploymentMutationOutcome} data
 * instead of catching backend-specific CCF exceptions (#2441 B2).
 */
export interface DeploymentsLifecyclePort {
  // [Issue #2441 / Phase B2] Conditional/atomic writes. Every DynamoDB
  // UpdateExpression / ConditionExpression lives in the backend verbatim; callers
  // consume outcome data instead of catching backend-specific CCF exceptions.

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

  /**
   * [Issue #2441 / Phase B PR-6] DeployDelete SFN `MarkDeleted`: unconditional
   * `SET #status = :status, updatedAt = :updatedAt REMOVE GSI2PK, GSI2SK` — same
   * at-least-once, condition-free semantics as {@link markCreateInProgress}. The
   * `REMOVE GSI2PK, GSI2SK` clears the sparse participant-login-key index (SQL
   * backends clear the `team_login_key_hash` column instead) so a deleted
   * deployment no longer resolves via `listByTeamLoginKey`. DeployDelete's own
   * `MarkFailed` state reuses {@link markCreateFailed} (with `buildId` undefined)
   * since the DDB UpdateExpression is byte-identical.
   */
  markDeleted(jobId: string, at: string): Promise<DeploymentMutationOutcome>;

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

  markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  /**
   * Issue #2651: the scheduled reconciler's independent recovery write for a DeployCreate
   * execution that outlived the state-machine timeout. The update is conditional on the current
   * status still being PENDING or IN_PROGRESS, so a concurrent MarkSucceeded/MarkFailed wins
   * without being overwritten.
   */
  markStuckCreatingFailed(
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
}

/**
 * [Issue #2527 Slice 2] Scoring + participant-experience capability — score
 * mutations (flag / multi-flag / hint / kind results / gate bonus), the
 * score-event and inter-team inbox sub-aggregates (reads and appends), and the
 * participant's own display-name write. Conditional writes follow the same
 * {@link DeploymentMutationOutcome} union contract as the lifecycle port.
 */
export interface DeploymentsScoringPort {
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

  latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome>;

  awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  setScoringState(jobId: string, stateJson: string, at: string): Promise<DeploymentMutationOutcome>;

  // [Issue #2441 / Phase B3] Sub-aggregate writes (verbatim Puts / conditional
  // Put moved from `handlers/shared/`).

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
}

/**
 * [Issue #2527] Composite-deployment capability (#2061) —
 * parent/target persistence, parent status CAS, target failure folding, and the
 * two composite reconciler Scans (per-page callback contract as on
 * {@link DeploymentsQueryPort}).
 */
export interface DeploymentsCompositePort {
  /**
   * A composite parent's target rows (GSI3 `PARENT_DEPLOYMENT#<id>`,
   * `ScanIndexForward=true` = declared order, single page). Site:
   * `deploy-handler/composite-repository.ts`. The `isCompositeTargetItem` filter
   * stays in the caller (the sparse GSI3 already scopes to target rows).
   */
  listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]>;

  putCompositeParent(record: CompositeParentDeploymentRecord): Promise<DeploymentMutationOutcome>;

  putCompositeTarget(record: CompositeTargetDeploymentRecord): Promise<DeploymentMutationOutcome>;

  casCompositeParentStatus(
    jobId: string,
    previousStatus: DeploymentStatus,
    nextStatus: DeploymentStatus,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome>;

  markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome>;

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
}

/**
 * [Issue #2527] Inter-team coordination state — the
 * per-event opaque plugin state with optimistic-lock versioning.
 */
export interface DeploymentsCoordinationPort {
  /**
   * The inter-team coordination state for one {@link CoordinationStateScope}
   * (`GetItem` `PK = COORD#<tenantId>#<eventId>#<problemId>#<runId>`,
   * `SK = STATE`). Returns `undefined` when the row is absent (=
   * uninitialized). Site: `participant-handler/coordination-store.ts`
   * `readCoordinationState`.
   *
   * [Issue #3123] Rows written before the scope existed live under the old
   * two-part key and are deliberately NOT returned here — inheriting them
   * would hand one problem's game state to whichever OTHER problem in the
   * same event happened to read first. See {@link
   * PRE_SCOPE_COORDINATION_NAMESPACE}.
   */
  readCoordinationState(
    scope: CoordinationStateScope,
  ): Promise<CoordinationStateRecord | undefined>;

  /**
   * Optimistic-lock write of one scope's coordination state (`PutItem`,
   * `ConditionExpression "attribute_not_exists(version) OR version =
   * :expected"`, `version` set to `expectedVersion + 1`). Mirrors the A2/B2
   * union contract: `conflict` folds the DynamoDB `ConditionalCheckFailed`
   * instead of throwing (never `not_found` — a first write creates the row).
   * Site: `participant-handler/coordination-store.ts` `writeCoordinationState`.
   *
   * `expiresAt` is the row's TTL (epoch seconds, {@link
   * coordinationStateExpiresAt}) — a retention backstop for a cleanup that
   * never ran, refreshed by every write so it only starts counting once a
   * match stops being played.
   */
  writeCoordinationState(
    scope: CoordinationStateScope,
    state: unknown,
    expectedVersion: number,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;

  /**
   * [Issue #3123] Pushes a live row's TTL out without touching `state` or
   * `version`.
   *
   * The TTL alone cannot tell "this match is over" from "nobody has moved
   * lately": `writeCoordinationState` refreshes it, but a plugin with no `tick`
   * hook (`microservice-migration-battle`'s `router.ts` is one) only writes when
   * a participant acts. In an open-ended event its registration state would
   * simply age out and the next request would silently rebuild from
   * `plugin.initialState`.
   *
   * The tick is the liveness signal that fixes it: it runs once a minute for
   * every coordination problem in a started event, whether or not the plugin
   * has a `tick` hook, and stops when the event does. Refreshing from there
   * means the retention clock starts when the EVENT goes quiet rather than when
   * the participants do.
   *
   * Deliberately version-free. Bumping `version` every minute would invalidate
   * in-flight optimistic locks and manufacture conflicts against a row nothing
   * semantically changed.
   *
   * A no-op when the row is absent — there is nothing to keep alive.
   */
  touchCoordinationState(scope: CoordinationStateScope, expiresAt: number): Promise<void>;

  /**
   * [Issue #3123] Removes exactly one scope's coordination state, and nothing
   * else. Idempotent: deleting an absent row is a success, so a retried or
   * partially-completed teardown converges instead of erroring.
   *
   * This is also the run-reset primitive — the next op re-materializes the
   * namespace from `plugin.initialState(ctx)` at version 0.
   */
  deleteCoordinationState(scope: CoordinationStateScope): Promise<void>;

  /**
   * [Issue #3149] Deletes one scope's coordination state only if it is still at
   * `expectedVersion`, folding a lost race into `{ outcome: "conflict" }`.
   *
   * ## Why cleanup needs a conditional delete at all
   *
   * The caller that wants this is deciding "is this problem's last deployment
   * gone", and that decision is a read. Read-then-delete races: between the
   * count and the delete, a new deployment can arrive and its first operation
   * can write state — and the unconditional {@link deleteCoordinationState}
   * would then remove a match that is being played, reporting success.
   *
   * Conditioning the delete on the version the caller read closes it, because
   * the only way a live match reaches this window is by writing, and writing is
   * exactly what moves the version. A new deployment that has NOT written
   * anything yet is not a match in progress: it re-materializes from
   * `plugin.initialState` on its first operation, which is what it would have
   * done had it arrived a moment later.
   *
   * ## What `expectedVersion` 0 means here, and why it is refused
   *
   * A version of 0 is "no row", and this method requires a row to condition on.
   * The backends therefore treat it as a programming error rather than
   * silently deleting unconditionally — which would reintroduce the race in the
   * one case the caller is least able to reason about.
   *
   * Never `not_found`: a row that vanished between the read and this call is
   * reported as `conflict`, because from the caller's point of view both mean
   * "the state you were about to remove is not the state that is there now".
   */
  deleteCoordinationStateIfUnchanged(
    scope: CoordinationStateScope,
    expectedVersion: number,
  ): Promise<DeploymentMutationOutcome>;

  /**
   * [Issue #3133] Returns this match's server-only secret, minting `candidate`
   * on the first call for the scope and returning the already-stored value on
   * every call after that.
   *
   * Insert-if-absent rather than read-then-write: two concurrent first ops race
   * here, and both must end up with the SAME secret. A plugin derives its
   * hidden material from this value, so two teams holding different secrets for
   * one match would not be a stale read — it would be two incompatible games.
   * The backends implement it with a conditional put / `INSERT OR IGNORE` and
   * return whatever is stored afterwards, so the loser of the race adopts the
   * winner's value.
   *
   * The secret lives in its OWN row, not as a field on the state row, and this
   * is the only method that reads it. That is the structural half of "never
   * projected": {@link readCoordinationState} cannot carry it into a
   * {@link CoordinationStateRecord}, so no projection, log line, or response
   * built from that record can leak it by accident.
   *
   * `expiresAt` matches the state row's TTL so the pair ages out together —
   * a surviving secret for a deleted match is dead weight, and a surviving
   * match with a deleted secret would re-mint mid-game.
   */
  ensureCoordinationMatchSecret(
    scope: CoordinationStateScope,
    candidate: string,
    expiresAt: number,
  ): Promise<string>;

  /**
   * [Issue #3133] Reads this match's secret without minting one, for the
   * read-only projection path. `undefined` means no op has created the match
   * yet; the plugin then sees `ctx.matchSecret === undefined` and falls back.
   *
   * Polling must not mint: the portal polls before the first op, and a mint
   * there would write on a GET and hand out a secret for a match that may never
   * start.
   */
  readCoordinationMatchSecret(scope: CoordinationStateScope): Promise<string | undefined>;

  /**
   * [Issue #3153] The run pointer for one `(tenant, event, problem)`, or
   * `undefined` when none has been written.
   *
   * `undefined` is not an error and not "no match": it means this problem has
   * never been reset, so it is still on its first run. The caller resolves that
   * to {@link DEFAULT_COORDINATION_RUN_ID} — see `domain/coordination-run.ts`
   * for why the first run keeps the old constant instead of being minted.
   */
  readCoordinationRun(key: CoordinationRunKey): Promise<CoordinationRunPointer | undefined>;

  /**
   * [Issue #3153] Replaces the pointer, but only while it still names
   * `expectedRunId`.
   *
   * Conditional for the same reason every other write in this port is: two
   * operators resetting the same match at once must not both mint a run. The
   * loser gets `conflict` and can re-read to see which run actually started,
   * instead of both of them believing they own the current match while state
   * accumulates under two ids.
   *
   * `expectedRunId` may be {@link DEFAULT_COORDINATION_RUN_ID} with no row
   * present, which is how the first rotation of a pre-existing match works: the
   * backends treat "no row" and "row naming the default" as the same starting
   * point, because they mean the same thing.
   *
   * Never `not_found` — an absent row is a valid target for the first
   * rotation.
   */
  rotateCoordinationRun(
    key: CoordinationRunKey,
    expectedRunId: string,
    pointer: CoordinationRunPointer,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome>;

  /**
   * [Issue #3153] Removes the run pointer for a `(tenant, event, problem)`.
   *
   * Called when the problem itself goes — event teardown, or the last
   * deployment being torn down. Leaving it would make a re-deployed problem
   * resume the retired match's run id, and with it that run's tombstoned
   * artifact prefix.
   */
  deleteCoordinationRun(key: CoordinationRunKey): Promise<void>;

  /**
   * [Issue #3123] Deletes every coordination row whose TTL has passed
   * (`expiresAt > 0 AND expiresAt <= nowEpochSeconds`), returning how many
   * were removed.
   *
   * On DynamoDB this duplicates the table's native TTL sweep. It exists so the
   * SQLite/Turso backend — which has no native TTL — has the same primitive,
   * the same way `dynamodb-ttl-sweep.ts` already unifies the other five
   * repositories.
   *
   * [Issue #3127] Scheduled since: the generic-scoring reconciler's per-minute
   * `pruneExpiredControlData` tick calls this alongside the other five
   * aggregates' `pruneExpired`, gated on `needsManualPrune()` so it only runs
   * on the pure-SQL backend. It was the one aggregate that tick missed, because
   * the other five spell the same operation `pruneExpired` and this one does
   * not; until it was wired, `CONTROL_DATA_BACKEND=turso` kept expired
   * coordination rows readable indefinitely while DynamoDB reaped its own.
   */
  sweepExpiredCoordinationState(nowEpochSeconds: number): Promise<number>;
}

/**
 * [Issue #2441] Aggregate-scoped repository for the Deployments
 * aggregate — domain methods, not a generic key-value shim (mirror of
 * {@link EventsRepository} / {@link TeamsRepository}). Two interchangeable
 * backends implement it: `DynamoDbDeploymentsRepository` (status quo, default)
 * and `SqlDeploymentsRepository` (SQLite dialect for Turso / D1).
 *
 * [Issue #2527 Slice 2] This is the COMPOSITION of the five capability ports
 * above — it exists only for the composition boundaries (backend implementors
 * and the cold-start resolver facades). Consumers must depend on the minimal
 * capability port(s) they call, never on this full surface.
 *
 * Fixed contract for every method (inherited by all five ports):
 *  - The DynamoDB request (KeyCondition / Filter / Projection / placeholder
 *    names / Limit / ScanIndexForward / UpdateExpression / ConditionExpression)
 *    is a **verbatim** relocation of the named pre-seam site — the seam changes
 *    zero request bytes.
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
export interface DeploymentsRepository
  extends DeploymentsQueryPort,
    DeploymentsLifecyclePort,
    DeploymentsScoringPort,
    DeploymentsCompositePort,
    DeploymentsCoordinationPort {}
