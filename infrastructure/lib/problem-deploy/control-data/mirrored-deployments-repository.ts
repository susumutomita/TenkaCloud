import type {
  BulkDeploymentCreateEntry,
  CompositeParentDeploymentRecord,
  CompositeTargetDeploymentRecord,
  CoordinationStateRecord,
  DeploymentKindScoringResult,
  DeploymentMutationOutcome,
  DeploymentRecord,
  DeploymentSchedulePatch,
  DeploymentsPage,
  DeploymentsRepository,
  InboxEventRecord,
  ScoreEventRecord,
} from "./types.js";

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

  async markStuckCreatingFailed(
    jobId: string,
    reason: string,
    at: string,
  ): Promise<DeploymentMutationOutcome> {
    return this.mirrorWrite(await this.canonical.markStuckCreatingFailed(jobId, reason, at), () =>
      this.replica.markStuckCreatingFailed(jobId, reason, at),
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
