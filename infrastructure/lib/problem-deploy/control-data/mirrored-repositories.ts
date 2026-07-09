import type { IdpScope } from "../../control-plane/handlers/idp-handler/core.js";
import type { CompetitorAccountItem } from "../handlers/competitor-accounts-handler/types.js";
import type { DisruptionAuditRow } from "../handlers/event-handler/disruption-types.js";
import type { ProgressionGateConfig } from "../handlers/shared/progression-gate.js";
import type {
  AdminAuditLogPage,
  AdminAuditLogRepository,
  AdminAuditRow,
  BulkDeploymentCreateEntry,
  ClearProgressionGateOutcome,
  CompetitorAccountMutationOutcome,
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  CoordinationStateRecord,
  CreateCompetitorAccountOutcome,
  CreateEventWithTeamsOutcome,
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsPage,
  DeploymentsRepository,
  DisruptionAuditPage,
  DisruptionClaimOutcome,
  DisruptionExecutionClaimInput,
  DisruptionRecurringMutationOutcome,
  DisruptionRecurringRecord,
  DisruptionsRepository,
  EventMutationOutcome,
  EventRecord,
  EventSchedulePatch,
  EventScoringMeta,
  EventsPage,
  EventsRepository,
  FeatureFlagsRepository,
  InboxEventRecord,
  NotificationRecord,
  NotificationsPage,
  NotificationsRepository,
  ProblemEndpointRecord,
  ProblemEndpointsRepository,
  SamlConfigRecord,
  SamlConfigRepository,
  SamlIdpRecord,
  SamlIdpsRepository,
  ScheduleFiredKind,
  ScoreEventRecord,
  TeamRecord,
  TeamsRepository,
  TenantFeatureFlagsRecord,
} from "./types.js";

function sameEventRecord(left: EventRecord, right: EventRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutLoginKey(record: TeamRecord): Omit<TeamRecord, "teamLoginKey"> {
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = record;
  return safeRecord;
}

function sameTeamRecord(left: TeamRecord, right: TeamRecord): boolean {
  return JSON.stringify(withoutLoginKey(left)) === JSON.stringify(withoutLoginKey(right));
}

function restoreLoginKey(record: TeamRecord, canonical: TeamRecord): TeamRecord {
  return canonical.teamLoginKey ? { ...record, teamLoginKey: canonical.teamLoginKey } : record;
}

/**
 * DynamoDB-primary/SQL-replica equivalent for the Deployments aggregate.
 *
 * Reads and scan callbacks deliberately pass through to canonical DynamoDB:
 * deployment cursors and scan page boundaries are backend-specific, and B4's
 * mirror mode is for write shadowing, not read-repair. Writes commit to
 * canonical first and only apply to the replica when the canonical outcome is
 * `updated`.
 */
export class MirroredDeploymentsRepository implements DeploymentsRepository {
  constructor(
    private readonly canonical: DeploymentsRepository,
    private readonly replica: DeploymentsRepository,
  ) {}

  private async mirrorWrite<T extends DeploymentMutationOutcome>(
    canonicalOutcome: T,
    applyToReplica: () => Promise<unknown>,
  ): Promise<T> {
    if (canonicalOutcome.outcome === "updated") await applyToReplica();
    return canonicalOutcome;
  }

  getDeployment(jobId: string): Promise<DeploymentRecord | undefined> {
    return this.canonical.getDeployment(jobId);
  }

  queryDeploymentMeta(jobId: string): Promise<DeploymentRecord | undefined> {
    return this.canonical.queryDeploymentMeta(jobId);
  }

  listByTenantPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DeploymentsPage> {
    return this.canonical.listByTenantPage(tenantId, opts);
  }

  countActiveByTenant(
    tenantId: string,
    activeStatuses: readonly string[],
    opts?: { readonly stopAtCount?: number },
  ): Promise<number> {
    return this.canonical.countActiveByTenant(tenantId, activeStatuses, opts);
  }

  listByTenantAndEvent(tenantId: string, eventId: string): Promise<readonly DeploymentRecord[]> {
    return this.canonical.listByTenantAndEvent(tenantId, eventId);
  }

  listDeploymentKeysByEvent(tenantId: string, eventId: string): Promise<readonly string[]> {
    return this.canonical.listDeploymentKeysByEvent(tenantId, eventId);
  }

  listReconcilerRowsByEvent(
    tenantId: string,
    eventId: string,
  ): Promise<readonly Pick<DeploymentRecord, "jobId" | "status" | "updatedAt">[]> {
    return this.canonical.listReconcilerRowsByEvent(tenantId, eventId);
  }

  listByEventTeamProblem(
    tenantId: string,
    eventId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly DeploymentRecord[]> {
    return this.canonical.listByEventTeamProblem(tenantId, eventId, teamId, problemId);
  }

  findByNamePrefix(
    tenantId: string,
    namePrefix: string,
  ): Promise<readonly Pick<DeploymentRecord, "namePrefix" | "jobId" | "status">[]> {
    return this.canonical.findByNamePrefix(tenantId, namePrefix);
  }

  listDeploymentSummariesByTenant(
    tenantId: string,
  ): Promise<
    readonly Pick<
      DeploymentRecord,
      "jobId" | "teamId" | "eventId" | "displayTeamName" | "teamName" | "problemId" | "status"
    >[]
  > {
    return this.canonical.listDeploymentSummariesByTenant(tenantId);
  }

  listByTeamLoginKey(teamLoginKey: string): Promise<readonly DeploymentRecord[]> {
    return this.canonical.listByTeamLoginKey(teamLoginKey);
  }

  listCompositeTargets(parentDeploymentId: string): Promise<readonly DeploymentRecord[]> {
    return this.canonical.listCompositeTargets(parentDeploymentId);
  }

  listScoreEvents(
    jobId: string,
    opts: { readonly pageSize: number; readonly maxPages?: number },
  ): Promise<readonly ScoreEventRecord[]> {
    return this.canonical.listScoreEvents(jobId, opts);
  }

  listScoreEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly ScoreEventRecord[]> {
    return this.canonical.listScoreEventsInRange(jobId, fromSk, toSk);
  }

  listInboxEventsInRange(
    jobId: string,
    fromSk: string,
    toSk: string,
  ): Promise<readonly InboxEventRecord[]> {
    return this.canonical.listInboxEventsInRange(jobId, fromSk, toSk);
  }

  readCoordinationState(
    tenantId: string,
    eventId: string,
  ): Promise<CoordinationStateRecord | undefined> {
    return this.canonical.readCoordinationState(tenantId, eventId);
  }

  forEachCompleteDeploymentPage(
    eventId: string | undefined,
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachCompleteDeploymentPage(eventId, onPage);
  }

  forEachCompositeDeployReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachCompositeDeployReconcilablePage(onPage);
  }

  forEachCompositeTeardownPendingPage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachCompositeTeardownPendingPage(onPage);
  }

  forEachRuntimeReconcilablePage(
    onPage: (items: readonly DeploymentRecord[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachRuntimeReconcilablePage(onPage);
  }

  forEachRuntimeScoreFeedPage(
    eventId: string,
    onPage: (
      items: readonly Pick<DeploymentRecord, "eventId" | "teamId" | "problemId" | "score">[],
    ) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachRuntimeScoreFeedPage(eventId, onPage);
  }

  async putDeployment(record: DeploymentRecord): Promise<void> {
    await this.canonical.putDeployment(record);
    await this.replica.putDeployment(record);
  }

  async markCreateInProgress(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markCreateInProgress(jobId, at), () =>
      this.replica.markCreateInProgress(jobId, at),
    );
  }

  async markCreateSucceeded(
    jobId: string,
    stackId: string,
    stackOutputs: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.markCreateSucceeded(jobId, stackId, stackOutputs, buildId, at),
      () => this.replica.markCreateSucceeded(jobId, stackId, stackOutputs, buildId, at),
    );
  }

  async markCreateFailed(
    jobId: string,
    failureReason: string,
    buildId: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.markCreateFailed(jobId, failureReason, buildId, at),
      () => this.replica.markCreateFailed(jobId, failureReason, buildId, at),
    );
  }

  async markDeleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markDeleted(jobId, at), () =>
      this.replica.markDeleted(jobId, at),
    );
  }

  async markFailedIfPending(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.markFailedIfPending(jobId, tenantId, reason, at, expiresAt),
      () => this.replica.markFailedIfPending(jobId, tenantId, reason, at, expiresAt),
    );
  }

  async retryToPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.retryToPending(jobId, tenantId, at), () =>
      this.replica.retryToPending(jobId, tenantId, at),
    );
  }

  async compensateRetryToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.compensateRetryToFailed(jobId, tenantId, reason, at, expiresAt),
      () => this.replica.compensateRetryToFailed(jobId, tenantId, reason, at, expiresAt),
    );
  }

  async markDeleting(
    jobId: string,
    tenantId: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markDeleting(jobId, tenantId, at, expiresAt), () =>
      this.replica.markDeleting(jobId, tenantId, at, expiresAt),
    );
  }

  async compensateDeleteToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
    expiresAt: number,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.compensateDeleteToFailed(jobId, tenantId, reason, at, expiresAt),
      () => this.replica.compensateDeleteToFailed(jobId, tenantId, reason, at, expiresAt),
    );
  }

  async markApprovalPending(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markApprovalPending(jobId, tenantId, at), () =>
      this.replica.markApprovalPending(jobId, tenantId, at),
    );
  }

  async failCompositeTargetIfPending(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.failCompositeTargetIfPending(jobId, reason, at),
      () => this.replica.failCompositeTargetIfPending(jobId, reason, at),
    );
  }

  async markCompositeParentDeleting(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markCompositeParentDeleting(jobId, at), () =>
      this.replica.markCompositeParentDeleting(jobId, at),
    );
  }

  async putCompositeParent(
    record: CompositeParentDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.putCompositeParent(record), () =>
      this.replica.putCompositeParent(record),
    );
  }

  async putCompositeTarget(
    record: CompositeTargetDeploymentRecord,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.putCompositeTarget(record), () =>
      this.replica.putCompositeTarget(record),
    );
  }

  async applyMultiFlagCorrectScore(
    jobId: string,
    points: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.applyMultiFlagCorrectScore(jobId, points, flagId, at),
      () => this.replica.applyMultiFlagCorrectScore(jobId, points, flagId, at),
    );
  }

  async applyMultiFlagWrongPenalty(
    jobId: string,
    penalty: number,
    flagId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.applyMultiFlagWrongPenalty(jobId, penalty, flagId, at),
      () => this.replica.applyMultiFlagWrongPenalty(jobId, penalty, flagId, at),
    );
  }

  async applyFlagWrongPenalty(
    jobId: string,
    penalty: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.applyFlagWrongPenalty(jobId, penalty, at), () =>
      this.replica.applyFlagWrongPenalty(jobId, penalty, at),
    );
  }

  async applyFlagCorrectScore(
    jobId: string,
    points: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.applyFlagCorrectScore(jobId, points, at), () =>
      this.replica.applyFlagCorrectScore(jobId, points, at),
    );
  }

  async applyHintPenalty(
    jobId: string,
    hint: Parameters<DeploymentsRepository["applyHintPenalty"]>[1],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.applyHintPenalty(jobId, hint, at), () =>
      this.replica.applyHintPenalty(jobId, hint, at),
    );
  }

  async updateDisplayTeamName(
    jobId: string,
    name: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.updateDisplayTeamName(jobId, name, at), () =>
      this.replica.updateDisplayTeamName(jobId, name, at),
    );
  }

  async applyKindScoringResult(
    jobId: string,
    result: DeploymentKindScoringResult,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.applyKindScoringResult(jobId, result, at), () =>
      this.replica.applyKindScoringResult(jobId, result, at),
    );
  }

  async casCompositeParentStatus(
    jobId: string,
    previousStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[1],
    nextStatus: Parameters<DeploymentsRepository["casCompositeParentStatus"]>[2],
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.casCompositeParentStatus(jobId, previousStatus, nextStatus, at),
      () => this.replica.casCompositeParentStatus(jobId, previousStatus, nextStatus, at),
    );
  }

  async latchGateCompleted(jobId: string, at: string): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.latchGateCompleted(jobId, at), () =>
      this.replica.latchGateCompleted(jobId, at),
    );
  }

  async awardGateBonusAtomic(
    parent: Pick<DeploymentRecord, "jobId" | "problemId" | "teamId" | "eventId" | "expiresAt">,
    bonus: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.awardGateBonusAtomic(parent, bonus, at), () =>
      this.replica.awardGateBonusAtomic(parent, bonus, at),
    );
  }

  async setScoringState(
    jobId: string,
    stateJson: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.setScoringState(jobId, stateJson, at), () =>
      this.replica.setScoringState(jobId, stateJson, at),
    );
  }

  async markStuckDeletingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markStuckDeletingFailed(jobId, reason, at), () =>
      this.replica.markStuckDeletingFailed(jobId, reason, at),
    );
  }

  async transitionRuntimeStatus(
    jobId: string,
    tenantId: string,
    currentStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[2],
    nextStatus: Parameters<DeploymentsRepository["transitionRuntimeStatus"]>[3],
    stackOutputs: string | undefined,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.transitionRuntimeStatus(
        jobId,
        tenantId,
        currentStatus,
        nextStatus,
        stackOutputs,
        at,
      ),
      () =>
        this.replica.transitionRuntimeStatus(
          jobId,
          tenantId,
          currentStatus,
          nextStatus,
          stackOutputs,
          at,
        ),
    );
  }

  async compensateBulkTeardown(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.compensateBulkTeardown(jobId, tenantId, at), () =>
      this.replica.compensateBulkTeardown(jobId, tenantId, at),
    );
  }

  async markDeletingForBulk(
    jobId: string,
    tenantId: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markDeletingForBulk(jobId, tenantId, at), () =>
      this.replica.markDeletingForBulk(jobId, tenantId, at),
    );
  }

  async applySchedulePatch(
    jobId: string,
    tenantId: string,
    patch: DeploymentSchedulePatch,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.applySchedulePatch(jobId, tenantId, patch, at),
      () => this.replica.applySchedulePatch(jobId, tenantId, patch, at),
    );
  }

  async createBulkDeployments(
    tenantId: string,
    entries: readonly BulkDeploymentCreateEntry[],
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.createBulkDeployments(tenantId, entries), () =>
      this.replica.createBulkDeployments(tenantId, entries),
    );
  }

  async compensateBulkCreateToFailed(
    jobId: string,
    tenantId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.compensateBulkCreateToFailed(jobId, tenantId, reason, at),
      () => this.replica.compensateBulkCreateToFailed(jobId, tenantId, reason, at),
    );
  }

  async stampEventEndsAt(
    jobId: string,
    tenantId: string,
    endsAt: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.stampEventEndsAt(jobId, tenantId, endsAt, at),
      () => this.replica.stampEventEndsAt(jobId, tenantId, endsAt, at),
    );
  }

  async appendScoreEvent(record: ScoreEventRecord): Promise<void> {
    await this.canonical.appendScoreEvent(record);
    await this.replica.appendScoreEvent(record);
  }

  async appendInboxEvent(jobId: string, inboxId: string, record: InboxEventRecord): Promise<void> {
    await this.canonical.appendInboxEvent(jobId, inboxId, record);
    await this.replica.appendInboxEvent(jobId, inboxId, record);
  }

  async writeCoordinationState(
    tenantId: string,
    eventId: string,
    state: unknown,
    expectedVersion: number,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.writeCoordinationState(tenantId, eventId, state, expectedVersion, at),
      () => this.replica.writeCoordinationState(tenantId, eventId, state, expectedVersion, at),
    );
  }
}

/**
 * Phase-1 strangler repository.
 *
 * DynamoDB remains canonical so rollback is one flag flip. Writes commit there
 * before Turso; reads reconcile the SQL copy and return the reconciled SQL row.
 * Deletes and TTL pruning remove SQL first, which prevents a failed operation
 * from creating data that exists only in Turso.
 */
export class MirroredEventsRepository implements EventsRepository {
  constructor(
    private readonly canonical: EventsRepository,
    private readonly replica: EventsRepository,
  ) {}

  async getEvent(tenantId: string, eventId: string): Promise<EventRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getEvent(tenantId, eventId),
      this.replica.getEvent(tenantId, eventId),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteEvent(eventId);
      return undefined;
    }
    if (!replica || !sameEventRecord(canonical, replica)) {
      await this.replica.putEvent(canonical);
    }
    return (await this.replica.getEvent(tenantId, eventId)) ?? canonical;
  }

  async putEvent(record: EventRecord): Promise<void> {
    await this.canonical.putEvent(record);
    await this.replica.putEvent(record);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.replica.deleteEvent(eventId);
    await this.canonical.deleteEvent(eventId);
  }

  async listEventsByTenant(tenantId: string): Promise<readonly EventRecord[]> {
    const [canonical, replica] = await Promise.all([
      this.canonical.listEventsByTenant(tenantId),
      this.replica.listEventsByTenant(tenantId),
    ]);
    const canonicalById = new Map(canonical.map((record) => [record.eventId, record]));
    const replicaById = new Map(replica.map((record) => [record.eventId, record]));
    await Promise.all([
      ...canonical
        .filter((record) => {
          const mirrored = replicaById.get(record.eventId);
          return !mirrored || !sameEventRecord(record, mirrored);
        })
        .map((record) => this.replica.putEvent(record)),
      ...replica
        .filter((record) => !canonicalById.has(record.eventId))
        .map((record) => this.replica.deleteEvent(record.eventId)),
    ]);
    return this.replica.listEventsByTenant(tenantId);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }

  // ---------------------------------------------------------------------------
  // [Issue #2438 / Phase A3] List/scan/batch/count reads. These are read-only
  // aggregate views (a UI page, a reconciler sweep, a scoring batch, a count) —
  // unlike `getEvent` / `listEventsByTenant`, they have no per-record identity
  // to read-repair against, so the canonical (DynamoDB) result is returned
  // directly. Replica drift, if any, self-heals through the point-read /
  // tenant-list paths above the next time each record is touched.
  // ---------------------------------------------------------------------------

  async listEventsPage(
    tenantId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<EventsPage> {
    return this.canonical.listEventsPage(tenantId, opts);
  }

  async listEventsByStatus(statuses: readonly string[]): Promise<readonly EventRecord[]> {
    return this.canonical.listEventsByStatus(statuses);
  }

  async batchGetEvents(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, EventScoringMeta>> {
    return this.canonical.batchGetEvents(eventIds);
  }

  async countEventsByTenant(tenantId: string): Promise<number> {
    return this.canonical.countEventsByTenant(tenantId);
  }

  // ---------------------------------------------------------------------------
  // [Issue #2437] Conditional writes: canonical (DynamoDB) first, its outcome is
  // adopted, and the SAME domain operation is applied to the replica only when
  // the canonical write succeeded. A replica failure throws (fail loudly — no
  // silent fallback); a replica outcome mismatch from drift is left to the
  // read-repair paths above (every read reconciles the replica from canonical).
  // ---------------------------------------------------------------------------

  /** Adopt the canonical outcome; run the replica op only on a canonical success. */
  private async mirrorWrite<T extends { readonly outcome: string }>(
    canonicalOutcome: T,
    applyToReplica: () => Promise<unknown>,
  ): Promise<T> {
    if (canonicalOutcome.outcome === "updated" || canonicalOutcome.outcome === "created") {
      await applyToReplica();
    }
    return canonicalOutcome;
  }

  async endEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.endEvent(tenantId, eventId, at), () =>
      this.replica.endEvent(tenantId, eventId, at),
    );
  }

  async lockScoring(
    tenantId: string,
    eventId: string,
    lockedBy: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.lockScoring(tenantId, eventId, lockedBy, at), () =>
      this.replica.lockScoring(tenantId, eventId, lockedBy, at),
    );
  }

  async unlockScoring(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.unlockScoring(tenantId, eventId, at), () =>
      this.replica.unlockScoring(tenantId, eventId, at),
    );
  }

  async archiveEvent(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.archiveEvent(tenantId, eventId, at), () =>
      this.replica.archiveEvent(tenantId, eventId, at),
    );
  }

  async updateSchedule(
    tenantId: string,
    eventId: string,
    patch: EventSchedulePatch,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.updateSchedule(tenantId, eventId, patch, at), () =>
      this.replica.updateSchedule(tenantId, eventId, patch, at),
    );
  }

  async markTeardown(tenantId: string, eventId: string, at: string): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markTeardown(tenantId, eventId, at), () =>
      this.replica.markTeardown(tenantId, eventId, at),
    );
  }

  async setProgressionGate(
    tenantId: string,
    eventId: string,
    config: ProgressionGateConfig,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.setProgressionGate(tenantId, eventId, config, at),
      () => this.replica.setProgressionGate(tenantId, eventId, config, at),
    );
  }

  async clearProgressionGate(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<ClearProgressionGateOutcome> {
    return this.mirrorWrite(await this.canonical.clearProgressionGate(tenantId, eventId, at), () =>
      this.replica.clearProgressionGate(tenantId, eventId, at),
    );
  }

  async markDeploying(
    tenantId: string,
    eventId: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markDeploying(tenantId, eventId, at), () =>
      this.replica.markDeploying(tenantId, eventId, at),
    );
  }

  async transitionStatus(
    tenantId: string,
    eventId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.transitionStatus(tenantId, eventId, from, to, at),
      () => this.replica.transitionStatus(tenantId, eventId, from, to, at),
    );
  }

  async markScheduleFired(
    tenantId: string,
    eventId: string,
    kind: ScheduleFiredKind,
    at: string,
  ): Promise<EventMutationOutcome> {
    return this.mirrorWrite(
      await this.canonical.markScheduleFired(tenantId, eventId, kind, at),
      () => this.replica.markScheduleFired(tenantId, eventId, kind, at),
    );
  }

  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<CreateEventWithTeamsOutcome> {
    return this.mirrorWrite(await this.canonical.createEventWithTeams(event, teams), () =>
      this.replica.createEventWithTeams(event, teams),
    );
  }
}

/** DynamoDB-primary/Turso-replica equivalent for the Teams aggregate. */
export class MirroredTeamsRepository implements TeamsRepository {
  constructor(
    private readonly canonical: TeamsRepository,
    private readonly replica: TeamsRepository,
  ) {}

  async getTeam(
    tenantId: string,
    eventId: string,
    teamId: string,
  ): Promise<TeamRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getTeam(tenantId, eventId, teamId),
      this.replica.getTeam(tenantId, eventId, teamId),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteTeam(eventId, teamId);
      return undefined;
    }
    if (!replica || !sameTeamRecord(canonical, replica)) {
      await this.replica.putTeam(canonical);
    }
    const reconciled = await this.replica.getTeam(tenantId, eventId, teamId);
    return reconciled ? restoreLoginKey(reconciled, canonical) : canonical;
  }

  async getTeamByLoginKey(loginKey: string): Promise<TeamRecord | undefined> {
    const [canonical, replica] = await Promise.all([
      this.canonical.getTeamByLoginKey(loginKey),
      this.replica.getTeamByLoginKey(loginKey),
    ]);
    if (!canonical) {
      if (replica) await this.replica.deleteTeam(replica.eventId, replica.teamId);
      return undefined;
    }
    if (!replica || !sameTeamRecord(canonical, replica)) {
      await this.replica.putTeam(canonical);
    }
    return (await this.replica.getTeamByLoginKey(loginKey)) ?? canonical;
  }

  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    const [canonical, replica] = await Promise.all([
      this.canonical.listTeamsByEvent(eventId),
      this.replica.listTeamsByEvent(eventId),
    ]);
    const canonicalById = new Map(canonical.map((record) => [record.teamId, record]));
    const replicaById = new Map(replica.map((record) => [record.teamId, record]));
    await Promise.all([
      ...canonical
        .filter((record) => {
          const mirrored = replicaById.get(record.teamId);
          return !mirrored || !sameTeamRecord(record, mirrored);
        })
        .map((record) => this.replica.putTeam(record)),
      ...replica
        .filter((record) => !canonicalById.has(record.teamId))
        .map((record) => this.replica.deleteTeam(eventId, record.teamId)),
    ]);
    const reconciled = await this.replica.listTeamsByEvent(eventId);
    return reconciled.map((record) => {
      const canonicalRecord = canonicalById.get(record.teamId);
      return canonicalRecord ? restoreLoginKey(record, canonicalRecord) : record;
    });
  }

  async putTeam(record: TeamRecord): Promise<void> {
    await this.canonical.putTeam(record);
    await this.replica.putTeam(record);
  }

  async deleteTeam(eventId: string, teamId: string): Promise<void> {
    await this.replica.deleteTeam(eventId, teamId);
    await this.canonical.deleteTeam(eventId, teamId);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}

export class MirroredNotificationsRepository implements NotificationsRepository {
  constructor(
    private readonly canonical: NotificationsRepository,
    private readonly replica: NotificationsRepository,
  ) {}

  async append(record: NotificationRecord): Promise<void> {
    await this.canonical.append(record);
    await this.replica.append(record);
  }

  // [#2439] cursor は backend 固有 token のため read-repair せず canonical を返す(A3 と同じ)。
  async listByEvent(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<NotificationsPage> {
    return this.canonical.listByEvent(eventId, opts);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}

export class MirroredFeatureFlagsRepository implements FeatureFlagsRepository {
  constructor(
    private readonly canonical: FeatureFlagsRepository,
    private readonly replica: FeatureFlagsRepository,
  ) {}

  async get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined> {
    return this.canonical.get(tenantId);
  }

  // [#2439] この aggregate に delete は無く、 行は put 全置換でしか変わらない —
  // write-through で replica は収束する(read-repair 不要)。
  async put(record: TenantFeatureFlagsRecord): Promise<void> {
    await this.canonical.put(record);
    await this.replica.put(record);
  }
}

/**
 * [Issue #2442 / Phase C1] DynamoDB-primary/SQL-replica equivalent for the
 * ProblemEndpoints aggregate. Writes commit to canonical DynamoDB first and
 * only apply to the replica when the canonical write succeeds (unconditional
 * writes here — there is no CCF-style outcome to gate on, unlike
 * {@link MirroredDeploymentsRepository}). Reads pass through to canonical: a
 * (tenant, team, problem) override list is small (a handful of slots) and has
 * no cursor / scan-page state to reconcile, so there is nothing for read-repair
 * to buy over the Events/Teams style (mirrors
 * {@link MirroredDeploymentsRepository}'s read-passthrough, not
 * {@link MirroredTeamsRepository}'s read-repair).
 */
export class MirroredProblemEndpointsRepository implements ProblemEndpointsRepository {
  constructor(
    private readonly canonical: ProblemEndpointsRepository,
    private readonly replica: ProblemEndpointsRepository,
  ) {}

  queryOverrides(
    tenantId: string,
    teamId: string,
    problemId: string,
  ): Promise<readonly ProblemEndpointRecord[]> {
    return this.canonical.queryOverrides(tenantId, teamId, problemId);
  }

  async putOverride(record: ProblemEndpointRecord): Promise<void> {
    await this.canonical.putOverride(record);
    await this.replica.putOverride(record);
  }

  async deleteOverride(
    tenantId: string,
    teamId: string,
    problemId: string,
    slot: string,
  ): Promise<void> {
    await this.canonical.deleteOverride(tenantId, teamId, problemId, slot);
    await this.replica.deleteOverride(tenantId, teamId, problemId, slot);
  }
}

/**
 * [Issue #2442 / Phase C2] DynamoDB-primary/SQL-replica equivalent for the
 * CompetitorAccounts aggregate. Conditional writes commit to canonical
 * DynamoDB first; the replica only applies when the canonical outcome
 * signals success (`created` / `updated`), mirroring
 * {@link MirroredEventsRepository}'s conditional-write contract. Reads pass
 * through to canonical: the tenant's account list is small (no cursor / scan
 * state to reconcile) and `forEachCompetitorAccountPage` is a full-table
 * audit sweep, so there is nothing for read-repair to buy over
 * {@link MirroredProblemEndpointsRepository}'s read-passthrough style.
 */
export class MirroredCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(
    private readonly canonical: CompetitorAccountsRepository,
    private readonly replica: CompetitorAccountsRepository,
  ) {}

  async createAccount(record: CompetitorAccountRecord): Promise<CreateCompetitorAccountOutcome> {
    const outcome = await this.canonical.createAccount(record);
    if (outcome.outcome === "created") await this.replica.createAccount(record);
    return outcome;
  }

  listAccounts(tenantId: string): Promise<readonly CompetitorAccountRecord[]> {
    return this.canonical.listAccounts(tenantId);
  }

  getAccount(tenantId: string, awsAccountId: string): Promise<CompetitorAccountRecord | undefined> {
    return this.canonical.getAccount(tenantId, awsAccountId);
  }

  async markVerified(
    tenantId: string,
    awsAccountId: string,
    verifiedAt: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const outcome = await this.canonical.markVerified(tenantId, awsAccountId, verifiedAt);
    if (outcome.outcome === "updated") {
      await this.replica.markVerified(tenantId, awsAccountId, verifiedAt);
    }
    return outcome;
  }

  async deleteAccount(
    tenantId: string,
    awsAccountId: string,
  ): Promise<CompetitorAccountMutationOutcome> {
    const outcome = await this.canonical.deleteAccount(tenantId, awsAccountId);
    if (outcome.outcome === "updated") await this.replica.deleteAccount(tenantId, awsAccountId);
    return outcome;
  }

  hasRemainingAccounts(tenantId: string): Promise<boolean> {
    return this.canonical.hasRemainingAccounts(tenantId);
  }

  forEachCompetitorAccountPage(
    onPage: (items: readonly Partial<CompetitorAccountItem>[]) => Promise<void>,
  ): Promise<void> {
    return this.canonical.forEachCompetitorAccountPage(onPage);
  }
}

/**
 * [Issue #2442 / Phase C2] DynamoDB-primary/SQL-replica equivalent for the
 * SamlConfig sub-aggregate (mirrors {@link MirroredFeatureFlagsRepository}'s
 * write-through, no-delete-repair shape — `putSamlConfig` is a full replace so
 * write-through alone keeps the replica converged; `deleteSamlConfig` is
 * idempotent on both backends).
 */
export class MirroredSamlConfigRepository implements SamlConfigRepository {
  constructor(
    private readonly canonical: SamlConfigRepository,
    private readonly replica: SamlConfigRepository,
  ) {}

  getSamlConfig(tenantId: string): Promise<SamlConfigRecord | undefined> {
    return this.canonical.getSamlConfig(tenantId);
  }

  async putSamlConfig(record: SamlConfigRecord): Promise<SamlConfigRecord> {
    const written = await this.canonical.putSamlConfig(record);
    await this.replica.putSamlConfig(record);
    return written;
  }

  async deleteSamlConfig(tenantId: string): Promise<void> {
    await this.canonical.deleteSamlConfig(tenantId);
    await this.replica.deleteSamlConfig(tenantId);
  }
}

/**
 * [Issue #2442 / Phase C3] DynamoDB-primary/SQL-replica equivalent for the Disruptions
 * aggregate. Idempotent claims (`claimFireIdempotency` / `claimExecutionSlot`) mirror
 * {@link MirroredCompetitorAccountsRepository.createAccount}'s contract: the replica write
 * only runs when canonical signals `claimed` (a canonical `already` means nothing new to
 * mirror — the replica already converged on the winner's earlier write, or will on its own
 * `already` outcome). Append-only writes (`appendAudit` / `putRecurringRegistry`) are
 * unconditional write-through (mirrors {@link MirroredNotificationsRepository.append}).
 * `cancelRecurringRegistry` mirrors {@link MirroredCompetitorAccountsRepository.markVerified}'s
 * conditional-write contract. Reads pass through to canonical — audit/registry rows have no
 * single-identity read-repair precedent to buy over
 * {@link MirroredProblemEndpointsRepository}'s read-passthrough style. `pruneExpired` removes
 * the SQL replica first (mirrors {@link MirroredEventsRepository.pruneExpired}).
 */
export class MirroredDisruptionsRepository implements DisruptionsRepository {
  constructor(
    private readonly canonical: DisruptionsRepository,
    private readonly replica: DisruptionsRepository,
  ) {}

  async claimFireIdempotency(draft: DisruptionAuditRow): Promise<DisruptionClaimOutcome> {
    const outcome = await this.canonical.claimFireIdempotency(draft);
    if (outcome.outcome === "claimed") await this.replica.claimFireIdempotency(draft);
    return outcome;
  }

  getFireIdempotencyRecord(
    tenantId: string,
    requestId: string,
  ): Promise<DisruptionAuditRow | undefined> {
    return this.canonical.getFireIdempotencyRecord(tenantId, requestId);
  }

  async appendAudit(record: DisruptionAuditRow): Promise<void> {
    await this.canonical.appendAudit(record);
    await this.replica.appendAudit(record);
  }

  listAuditPage(
    eventId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<DisruptionAuditPage> {
    return this.canonical.listAuditPage(eventId, opts);
  }

  listAuditSince(eventId: string, sinceIso: string): Promise<readonly DisruptionAuditRow[]> {
    return this.canonical.listAuditSince(eventId, sinceIso);
  }

  async putRecurringRegistry(record: DisruptionRecurringRecord): Promise<void> {
    await this.canonical.putRecurringRegistry(record);
    await this.replica.putRecurringRegistry(record);
  }

  listRecurringByEvent(
    eventId: string,
    tenantId: string,
  ): Promise<readonly DisruptionRecurringRecord[]> {
    return this.canonical.listRecurringByEvent(eventId, tenantId);
  }

  getRecurringRegistry(
    eventId: string,
    requestId: string,
  ): Promise<DisruptionRecurringRecord | undefined> {
    return this.canonical.getRecurringRegistry(eventId, requestId);
  }

  async cancelRecurringRegistry(
    eventId: string,
    requestId: string,
    tenantId: string,
    cancelledAt: string,
  ): Promise<DisruptionRecurringMutationOutcome> {
    const outcome = await this.canonical.cancelRecurringRegistry(
      eventId,
      requestId,
      tenantId,
      cancelledAt,
    );
    if (outcome.outcome === "updated") {
      await this.replica.cancelRecurringRegistry(eventId, requestId, tenantId, cancelledAt);
    }
    return outcome;
  }

  async claimExecutionSlot(input: DisruptionExecutionClaimInput): Promise<DisruptionClaimOutcome> {
    const outcome = await this.canonical.claimExecutionSlot(input);
    if (outcome.outcome === "claimed") await this.replica.claimExecutionSlot(input);
    return outcome;
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}

/**
 * DynamoDB-primary/SQL-replica equivalent for the AdminAuditLog aggregate (Issue #2442 / Phase
 * C4). Writes go to canonical then replica (best-effort ordering matches every other Mirrored
 * class in this file); reads (`listPage` / `listAllByPartition`) pass through to canonical DDB —
 * cursor formats and page boundaries are backend-specific, same rationale as every other Mirrored
 * read in this file.
 */
export class MirroredAdminAuditLogRepository implements AdminAuditLogRepository {
  constructor(
    private readonly canonical: AdminAuditLogRepository,
    private readonly replica: AdminAuditLogRepository,
  ) {}

  async appendAudit(row: AdminAuditRow): Promise<void> {
    await this.canonical.appendAudit(row);
    await this.replica.appendAudit(row);
  }

  listPage(
    pk: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ): Promise<AdminAuditLogPage> {
    return this.canonical.listPage(pk, opts);
  }

  listAllByPartition(
    pk: string,
    opts: { readonly pageSize: number; readonly maxPages: number },
  ): Promise<readonly AdminAuditRow[]> {
    return this.canonical.listAllByPartition(pk, opts);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    await this.replica.pruneExpired(nowEpochSeconds);
    return this.canonical.pruneExpired(nowEpochSeconds);
  }
}

/**
 * [Issue #2442 / Phase C5] DynamoDB-primary/SQL-replica equivalent for the SamlIdps aggregate
 * (mirrors {@link MirroredProblemEndpointsRepository}'s read-passthrough / write-through-both
 * style — no conditional writes, no Scan, the smallest of the C-series aggregates).
 */
export class MirroredSamlIdpsRepository implements SamlIdpsRepository {
  constructor(
    private readonly canonical: SamlIdpsRepository,
    private readonly replica: SamlIdpsRepository,
  ) {}

  list(scope: IdpScope): Promise<readonly SamlIdpRecord[]> {
    return this.canonical.list(scope);
  }

  get(scope: IdpScope, idpId: string): Promise<SamlIdpRecord | null> {
    return this.canonical.get(scope, idpId);
  }

  async put(scope: IdpScope, config: SamlIdpRecord): Promise<void> {
    await this.canonical.put(scope, config);
    await this.replica.put(scope, config);
  }

  async delete(scope: IdpScope, idpId: string): Promise<void> {
    await this.canonical.delete(scope, idpId);
    await this.replica.delete(scope, idpId);
  }
}
