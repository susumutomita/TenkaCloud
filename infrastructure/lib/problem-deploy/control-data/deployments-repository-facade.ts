import type {
  DeploymentsCompositePort,
  DeploymentsCoordinationPort,
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
  DeploymentsRepository,
  DeploymentsScoringPort,
} from "./types.js";

/** The five capability adapters a backend builds around its shared core engine. */
export interface DeploymentsRepositoryParts {
  readonly query: DeploymentsQueryPort;
  readonly lifecycle: DeploymentsLifecyclePort;
  readonly scoring: DeploymentsScoringPort;
  readonly composite: DeploymentsCompositePort;
  readonly coordination: DeploymentsCoordinationPort;
}

/**
 * [#2866 ← #2527 Slice 3] Shared delegation table for the Deployments seam
 * facades. The DynamoDB and SQLite repositories compose the same five capability
 * adapters (query / lifecycle / scoring / composite / coordination) and used to
 * forward every port method with byte-identical boilerplate in each backend file
 * (jscpd's largest clone, 146 lines x 2). The table now lives here once: a
 * backend subclass only builds its adapters around its core engine and passes
 * them up. Pure delegation — no request bytes change, and every existing
 * `new <Backend>DeploymentsRepository(...)` call site compiles untouched.
 */
export abstract class DeploymentsRepositoryFacade implements DeploymentsRepository {
  private readonly parts: DeploymentsRepositoryParts;

  protected constructor(parts: DeploymentsRepositoryParts) {
    this.parts = parts;
  }

  // ── DeploymentsQueryPort ────────────────────────────────────────
  readonly getDeployment: DeploymentsQueryPort["getDeployment"] = (...args) =>
    this.parts.query.getDeployment(...args);
  readonly queryDeploymentMeta: DeploymentsQueryPort["queryDeploymentMeta"] = (...args) =>
    this.parts.query.queryDeploymentMeta(...args);
  readonly listByTenantPage: DeploymentsQueryPort["listByTenantPage"] = (...args) =>
    this.parts.query.listByTenantPage(...args);
  readonly countActiveByTenant: DeploymentsQueryPort["countActiveByTenant"] = (...args) =>
    this.parts.query.countActiveByTenant(...args);
  readonly countEverCompletedByTenant: DeploymentsQueryPort["countEverCompletedByTenant"] = (
    ...args
  ) => this.parts.query.countEverCompletedByTenant(...args);
  readonly listByTenantAndEvent: DeploymentsQueryPort["listByTenantAndEvent"] = (...args) =>
    this.parts.query.listByTenantAndEvent(...args);
  readonly listDeploymentKeysByEvent: DeploymentsQueryPort["listDeploymentKeysByEvent"] = (
    ...args
  ) => this.parts.query.listDeploymentKeysByEvent(...args);
  readonly listReconcilerRowsByEvent: DeploymentsQueryPort["listReconcilerRowsByEvent"] = (
    ...args
  ) => this.parts.query.listReconcilerRowsByEvent(...args);
  readonly listByEventTeamProblem: DeploymentsQueryPort["listByEventTeamProblem"] = (...args) =>
    this.parts.query.listByEventTeamProblem(...args);
  readonly findByNamePrefix: DeploymentsQueryPort["findByNamePrefix"] = (...args) =>
    this.parts.query.findByNamePrefix(...args);
  readonly listDeploymentSummariesByTenant: DeploymentsQueryPort["listDeploymentSummariesByTenant"] =
    (...args) => this.parts.query.listDeploymentSummariesByTenant(...args);
  readonly listByTeamLoginKey: DeploymentsQueryPort["listByTeamLoginKey"] = (...args) =>
    this.parts.query.listByTeamLoginKey(...args);
  readonly forEachCompleteDeploymentPage: DeploymentsQueryPort["forEachCompleteDeploymentPage"] = (
    ...args
  ) => this.parts.query.forEachCompleteDeploymentPage(...args);
  readonly forEachRuntimeReconcilablePage: DeploymentsQueryPort["forEachRuntimeReconcilablePage"] =
    (...args) => this.parts.query.forEachRuntimeReconcilablePage(...args);

  // ── DeploymentsLifecyclePort ────────────────────────────────────
  readonly putDeployment: DeploymentsLifecyclePort["putDeployment"] = (...args) =>
    this.parts.lifecycle.putDeployment(...args);
  readonly markCreateInProgress: DeploymentsLifecyclePort["markCreateInProgress"] = (...args) =>
    this.parts.lifecycle.markCreateInProgress(...args);
  readonly markCreateSucceeded: DeploymentsLifecyclePort["markCreateSucceeded"] = (...args) =>
    this.parts.lifecycle.markCreateSucceeded(...args);
  readonly markCreateFailed: DeploymentsLifecyclePort["markCreateFailed"] = (...args) =>
    this.parts.lifecycle.markCreateFailed(...args);
  readonly markDeleted: DeploymentsLifecyclePort["markDeleted"] = (...args) =>
    this.parts.lifecycle.markDeleted(...args);
  readonly markFailedIfPending: DeploymentsLifecyclePort["markFailedIfPending"] = (...args) =>
    this.parts.lifecycle.markFailedIfPending(...args);
  readonly retryToPending: DeploymentsLifecyclePort["retryToPending"] = (...args) =>
    this.parts.lifecycle.retryToPending(...args);
  readonly compensateRetryToFailed: DeploymentsLifecyclePort["compensateRetryToFailed"] = (
    ...args
  ) => this.parts.lifecycle.compensateRetryToFailed(...args);
  readonly markDeleting: DeploymentsLifecyclePort["markDeleting"] = (...args) =>
    this.parts.lifecycle.markDeleting(...args);
  readonly compensateDeleteToFailed: DeploymentsLifecyclePort["compensateDeleteToFailed"] = (
    ...args
  ) => this.parts.lifecycle.compensateDeleteToFailed(...args);
  readonly markApprovalPending: DeploymentsLifecyclePort["markApprovalPending"] = (...args) =>
    this.parts.lifecycle.markApprovalPending(...args);
  readonly markStuckDeletingFailed: DeploymentsLifecyclePort["markStuckDeletingFailed"] = (
    ...args
  ) => this.parts.lifecycle.markStuckDeletingFailed(...args);
  readonly markStuckCreatingFailed: DeploymentsLifecyclePort["markStuckCreatingFailed"] = (
    ...args
  ) => this.parts.lifecycle.markStuckCreatingFailed(...args);
  readonly transitionRuntimeStatus: DeploymentsLifecyclePort["transitionRuntimeStatus"] = (
    ...args
  ) => this.parts.lifecycle.transitionRuntimeStatus(...args);
  readonly compensateBulkTeardown: DeploymentsLifecyclePort["compensateBulkTeardown"] = (...args) =>
    this.parts.lifecycle.compensateBulkTeardown(...args);
  readonly markDeletingForBulk: DeploymentsLifecyclePort["markDeletingForBulk"] = (...args) =>
    this.parts.lifecycle.markDeletingForBulk(...args);
  readonly applySchedulePatch: DeploymentsLifecyclePort["applySchedulePatch"] = (...args) =>
    this.parts.lifecycle.applySchedulePatch(...args);
  readonly createBulkDeployments: DeploymentsLifecyclePort["createBulkDeployments"] = (...args) =>
    this.parts.lifecycle.createBulkDeployments(...args);
  readonly compensateBulkCreateToFailed: DeploymentsLifecyclePort["compensateBulkCreateToFailed"] =
    (...args) => this.parts.lifecycle.compensateBulkCreateToFailed(...args);
  readonly stampEventEndsAt: DeploymentsLifecyclePort["stampEventEndsAt"] = (...args) =>
    this.parts.lifecycle.stampEventEndsAt(...args);

  // ── DeploymentsScoringPort ──────────────────────────────────────
  readonly applyMultiFlagCorrectScore: DeploymentsScoringPort["applyMultiFlagCorrectScore"] = (
    ...args
  ) => this.parts.scoring.applyMultiFlagCorrectScore(...args);
  readonly applyMultiFlagWrongPenalty: DeploymentsScoringPort["applyMultiFlagWrongPenalty"] = (
    ...args
  ) => this.parts.scoring.applyMultiFlagWrongPenalty(...args);
  readonly applyFlagWrongPenalty: DeploymentsScoringPort["applyFlagWrongPenalty"] = (...args) =>
    this.parts.scoring.applyFlagWrongPenalty(...args);
  readonly applyFlagCorrectScore: DeploymentsScoringPort["applyFlagCorrectScore"] = (...args) =>
    this.parts.scoring.applyFlagCorrectScore(...args);
  readonly applyHintPenalty: DeploymentsScoringPort["applyHintPenalty"] = (...args) =>
    this.parts.scoring.applyHintPenalty(...args);
  readonly updateDisplayTeamName: DeploymentsScoringPort["updateDisplayTeamName"] = (...args) =>
    this.parts.scoring.updateDisplayTeamName(...args);
  readonly applyKindScoringResult: DeploymentsScoringPort["applyKindScoringResult"] = (...args) =>
    this.parts.scoring.applyKindScoringResult(...args);
  readonly latchGateCompleted: DeploymentsScoringPort["latchGateCompleted"] = (...args) =>
    this.parts.scoring.latchGateCompleted(...args);
  readonly awardGateBonusAtomic: DeploymentsScoringPort["awardGateBonusAtomic"] = (...args) =>
    this.parts.scoring.awardGateBonusAtomic(...args);
  readonly setScoringState: DeploymentsScoringPort["setScoringState"] = (...args) =>
    this.parts.scoring.setScoringState(...args);
  readonly appendScoreEvent: DeploymentsScoringPort["appendScoreEvent"] = (...args) =>
    this.parts.scoring.appendScoreEvent(...args);
  readonly appendInboxEvent: DeploymentsScoringPort["appendInboxEvent"] = (...args) =>
    this.parts.scoring.appendInboxEvent(...args);
  readonly listScoreEvents: DeploymentsScoringPort["listScoreEvents"] = (...args) =>
    this.parts.scoring.listScoreEvents(...args);
  readonly listScoreEventsInRange: DeploymentsScoringPort["listScoreEventsInRange"] = (...args) =>
    this.parts.scoring.listScoreEventsInRange(...args);
  readonly listInboxEventsInRange: DeploymentsScoringPort["listInboxEventsInRange"] = (...args) =>
    this.parts.scoring.listInboxEventsInRange(...args);

  // ── DeploymentsCompositePort ────────────────────────────────────
  readonly listCompositeTargets: DeploymentsCompositePort["listCompositeTargets"] = (...args) =>
    this.parts.composite.listCompositeTargets(...args);
  readonly putCompositeParent: DeploymentsCompositePort["putCompositeParent"] = (...args) =>
    this.parts.composite.putCompositeParent(...args);
  readonly putCompositeTarget: DeploymentsCompositePort["putCompositeTarget"] = (...args) =>
    this.parts.composite.putCompositeTarget(...args);
  readonly casCompositeParentStatus: DeploymentsCompositePort["casCompositeParentStatus"] = (
    ...args
  ) => this.parts.composite.casCompositeParentStatus(...args);
  readonly failCompositeTargetIfPending: DeploymentsCompositePort["failCompositeTargetIfPending"] =
    (...args) => this.parts.composite.failCompositeTargetIfPending(...args);
  readonly markCompositeParentDeleting: DeploymentsCompositePort["markCompositeParentDeleting"] = (
    ...args
  ) => this.parts.composite.markCompositeParentDeleting(...args);
  readonly forEachCompositeDeployReconcilablePage: DeploymentsCompositePort["forEachCompositeDeployReconcilablePage"] =
    (...args) => this.parts.composite.forEachCompositeDeployReconcilablePage(...args);
  readonly forEachCompositeTeardownPendingPage: DeploymentsCompositePort["forEachCompositeTeardownPendingPage"] =
    (...args) => this.parts.composite.forEachCompositeTeardownPendingPage(...args);

  // ── DeploymentsCoordinationPort ─────────────────────────────────
  readonly readCoordinationState: DeploymentsCoordinationPort["readCoordinationState"] = (
    ...args
  ) => this.parts.coordination.readCoordinationState(...args);
  readonly writeCoordinationState: DeploymentsCoordinationPort["writeCoordinationState"] = (
    ...args
  ) => this.parts.coordination.writeCoordinationState(...args);
  readonly touchCoordinationState: DeploymentsCoordinationPort["touchCoordinationState"] = (
    ...args
  ) => this.parts.coordination.touchCoordinationState(...args);
  readonly deleteCoordinationState: DeploymentsCoordinationPort["deleteCoordinationState"] = (
    ...args
  ) => this.parts.coordination.deleteCoordinationState(...args);
  readonly deleteCoordinationStateIfUnchanged: DeploymentsCoordinationPort["deleteCoordinationStateIfUnchanged"] =
    (...args) => this.parts.coordination.deleteCoordinationStateIfUnchanged(...args);
  readonly readCoordinationRun: DeploymentsCoordinationPort["readCoordinationRun"] = (...args) =>
    this.parts.coordination.readCoordinationRun(...args);
  readonly rotateCoordinationRun: DeploymentsCoordinationPort["rotateCoordinationRun"] = (...args) =>
    this.parts.coordination.rotateCoordinationRun(...args);
  readonly deleteCoordinationRun: DeploymentsCoordinationPort["deleteCoordinationRun"] = (...args) =>
    this.parts.coordination.deleteCoordinationRun(...args);
  readonly sweepExpiredCoordinationState: DeploymentsCoordinationPort["sweepExpiredCoordinationState"] =
    (...args) => this.parts.coordination.sweepExpiredCoordinationState(...args);
  readonly ensureCoordinationMatchSecret: DeploymentsCoordinationPort["ensureCoordinationMatchSecret"] =
    (...args) => this.parts.coordination.ensureCoordinationMatchSecret(...args);
  readonly readCoordinationMatchSecret: DeploymentsCoordinationPort["readCoordinationMatchSecret"] =
    (...args) => this.parts.coordination.readCoordinationMatchSecret(...args);
}
