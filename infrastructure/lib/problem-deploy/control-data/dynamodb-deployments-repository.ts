import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbDeploymentsComposite } from "./dynamodb-deployments-composite.js";
import { DynamoDbDeploymentsCoordination } from "./dynamodb-deployments-coordination.js";
import { DynamoDbDeploymentsCore } from "./dynamodb-deployments-core.js";
import { DynamoDbDeploymentsLifecycle } from "./dynamodb-deployments-lifecycle.js";
import { DynamoDbDeploymentsQuery } from "./dynamodb-deployments-query.js";
import { DynamoDbDeploymentsScoring } from "./dynamodb-deployments-scoring.js";
import type {
  DeploymentsCompositePort,
  DeploymentsCoordinationPort,
  DeploymentsLifecyclePort,
  DeploymentsQueryPort,
  DeploymentsRepository,
  DeploymentsScoringPort,
} from "./types.js";

/**
 * [Issue #2441] DynamoDB implementation of the Deployments seam.
 * [#2527 Slice 3] Now a composition facade: the five capability adapters
 * (query / lifecycle / scoring / composite / coordination) share one
 * {@link DynamoDbDeploymentsCore} engine, and every port method below delegates to
 * exactly one capability class. The class name and constructor shape are
 * unchanged, so the resolver factories and tests compile untouched.
 */
export class DynamoDbDeploymentsRepository implements DeploymentsRepository {
  private readonly query: DynamoDbDeploymentsQuery;
  private readonly lifecycle: DynamoDbDeploymentsLifecycle;
  private readonly scoring: DynamoDbDeploymentsScoring;
  private readonly composite: DynamoDbDeploymentsComposite;
  private readonly coordination: DynamoDbDeploymentsCoordination;

  constructor(ddb: DynamoDBDocumentClient, tableName: string) {
    const core = new DynamoDbDeploymentsCore(ddb, tableName);
    this.query = new DynamoDbDeploymentsQuery(core);
    this.lifecycle = new DynamoDbDeploymentsLifecycle(core);
    this.scoring = new DynamoDbDeploymentsScoring(core);
    this.composite = new DynamoDbDeploymentsComposite(core);
    this.coordination = new DynamoDbDeploymentsCoordination(core);
  }

  // ── DeploymentsQueryPort ────────────────────────────────────────
  readonly getDeployment: DeploymentsQueryPort["getDeployment"] = (...args) =>
    this.query.getDeployment(...args);
  readonly queryDeploymentMeta: DeploymentsQueryPort["queryDeploymentMeta"] = (...args) =>
    this.query.queryDeploymentMeta(...args);
  readonly listByTenantPage: DeploymentsQueryPort["listByTenantPage"] = (...args) =>
    this.query.listByTenantPage(...args);
  readonly countActiveByTenant: DeploymentsQueryPort["countActiveByTenant"] = (...args) =>
    this.query.countActiveByTenant(...args);
  readonly listByTenantAndEvent: DeploymentsQueryPort["listByTenantAndEvent"] = (...args) =>
    this.query.listByTenantAndEvent(...args);
  readonly listDeploymentKeysByEvent: DeploymentsQueryPort["listDeploymentKeysByEvent"] = (
    ...args
  ) => this.query.listDeploymentKeysByEvent(...args);
  readonly listReconcilerRowsByEvent: DeploymentsQueryPort["listReconcilerRowsByEvent"] = (
    ...args
  ) => this.query.listReconcilerRowsByEvent(...args);
  readonly listByEventTeamProblem: DeploymentsQueryPort["listByEventTeamProblem"] = (...args) =>
    this.query.listByEventTeamProblem(...args);
  readonly findByNamePrefix: DeploymentsQueryPort["findByNamePrefix"] = (...args) =>
    this.query.findByNamePrefix(...args);
  readonly listDeploymentSummariesByTenant: DeploymentsQueryPort["listDeploymentSummariesByTenant"] =
    (...args) => this.query.listDeploymentSummariesByTenant(...args);
  readonly listByTeamLoginKey: DeploymentsQueryPort["listByTeamLoginKey"] = (...args) =>
    this.query.listByTeamLoginKey(...args);
  readonly forEachCompleteDeploymentPage: DeploymentsQueryPort["forEachCompleteDeploymentPage"] = (
    ...args
  ) => this.query.forEachCompleteDeploymentPage(...args);
  readonly forEachRuntimeReconcilablePage: DeploymentsQueryPort["forEachRuntimeReconcilablePage"] =
    (...args) => this.query.forEachRuntimeReconcilablePage(...args);
  readonly forEachRuntimeScoreFeedPage: DeploymentsQueryPort["forEachRuntimeScoreFeedPage"] = (
    ...args
  ) => this.query.forEachRuntimeScoreFeedPage(...args);

  // ── DeploymentsLifecyclePort ────────────────────────────────────
  readonly putDeployment: DeploymentsLifecyclePort["putDeployment"] = (...args) =>
    this.lifecycle.putDeployment(...args);
  readonly markCreateInProgress: DeploymentsLifecyclePort["markCreateInProgress"] = (...args) =>
    this.lifecycle.markCreateInProgress(...args);
  readonly markCreateSucceeded: DeploymentsLifecyclePort["markCreateSucceeded"] = (...args) =>
    this.lifecycle.markCreateSucceeded(...args);
  readonly markCreateFailed: DeploymentsLifecyclePort["markCreateFailed"] = (...args) =>
    this.lifecycle.markCreateFailed(...args);
  readonly markDeleted: DeploymentsLifecyclePort["markDeleted"] = (...args) =>
    this.lifecycle.markDeleted(...args);
  readonly markFailedIfPending: DeploymentsLifecyclePort["markFailedIfPending"] = (...args) =>
    this.lifecycle.markFailedIfPending(...args);
  readonly retryToPending: DeploymentsLifecyclePort["retryToPending"] = (...args) =>
    this.lifecycle.retryToPending(...args);
  readonly compensateRetryToFailed: DeploymentsLifecyclePort["compensateRetryToFailed"] = (
    ...args
  ) => this.lifecycle.compensateRetryToFailed(...args);
  readonly markDeleting: DeploymentsLifecyclePort["markDeleting"] = (...args) =>
    this.lifecycle.markDeleting(...args);
  readonly compensateDeleteToFailed: DeploymentsLifecyclePort["compensateDeleteToFailed"] = (
    ...args
  ) => this.lifecycle.compensateDeleteToFailed(...args);
  readonly markApprovalPending: DeploymentsLifecyclePort["markApprovalPending"] = (...args) =>
    this.lifecycle.markApprovalPending(...args);
  readonly markStuckDeletingFailed: DeploymentsLifecyclePort["markStuckDeletingFailed"] = (
    ...args
  ) => this.lifecycle.markStuckDeletingFailed(...args);
  readonly transitionRuntimeStatus: DeploymentsLifecyclePort["transitionRuntimeStatus"] = (
    ...args
  ) => this.lifecycle.transitionRuntimeStatus(...args);
  readonly compensateBulkTeardown: DeploymentsLifecyclePort["compensateBulkTeardown"] = (...args) =>
    this.lifecycle.compensateBulkTeardown(...args);
  readonly markDeletingForBulk: DeploymentsLifecyclePort["markDeletingForBulk"] = (...args) =>
    this.lifecycle.markDeletingForBulk(...args);
  readonly applySchedulePatch: DeploymentsLifecyclePort["applySchedulePatch"] = (...args) =>
    this.lifecycle.applySchedulePatch(...args);
  readonly createBulkDeployments: DeploymentsLifecyclePort["createBulkDeployments"] = (...args) =>
    this.lifecycle.createBulkDeployments(...args);
  readonly compensateBulkCreateToFailed: DeploymentsLifecyclePort["compensateBulkCreateToFailed"] =
    (...args) => this.lifecycle.compensateBulkCreateToFailed(...args);
  readonly stampEventEndsAt: DeploymentsLifecyclePort["stampEventEndsAt"] = (...args) =>
    this.lifecycle.stampEventEndsAt(...args);

  // ── DeploymentsScoringPort ──────────────────────────────────────
  readonly applyMultiFlagCorrectScore: DeploymentsScoringPort["applyMultiFlagCorrectScore"] = (
    ...args
  ) => this.scoring.applyMultiFlagCorrectScore(...args);
  readonly applyMultiFlagWrongPenalty: DeploymentsScoringPort["applyMultiFlagWrongPenalty"] = (
    ...args
  ) => this.scoring.applyMultiFlagWrongPenalty(...args);
  readonly applyFlagWrongPenalty: DeploymentsScoringPort["applyFlagWrongPenalty"] = (...args) =>
    this.scoring.applyFlagWrongPenalty(...args);
  readonly applyFlagCorrectScore: DeploymentsScoringPort["applyFlagCorrectScore"] = (...args) =>
    this.scoring.applyFlagCorrectScore(...args);
  readonly applyHintPenalty: DeploymentsScoringPort["applyHintPenalty"] = (...args) =>
    this.scoring.applyHintPenalty(...args);
  readonly updateDisplayTeamName: DeploymentsScoringPort["updateDisplayTeamName"] = (...args) =>
    this.scoring.updateDisplayTeamName(...args);
  readonly applyKindScoringResult: DeploymentsScoringPort["applyKindScoringResult"] = (...args) =>
    this.scoring.applyKindScoringResult(...args);
  readonly latchGateCompleted: DeploymentsScoringPort["latchGateCompleted"] = (...args) =>
    this.scoring.latchGateCompleted(...args);
  readonly awardGateBonusAtomic: DeploymentsScoringPort["awardGateBonusAtomic"] = (...args) =>
    this.scoring.awardGateBonusAtomic(...args);
  readonly setScoringState: DeploymentsScoringPort["setScoringState"] = (...args) =>
    this.scoring.setScoringState(...args);
  readonly appendScoreEvent: DeploymentsScoringPort["appendScoreEvent"] = (...args) =>
    this.scoring.appendScoreEvent(...args);
  readonly appendInboxEvent: DeploymentsScoringPort["appendInboxEvent"] = (...args) =>
    this.scoring.appendInboxEvent(...args);
  readonly listScoreEvents: DeploymentsScoringPort["listScoreEvents"] = (...args) =>
    this.scoring.listScoreEvents(...args);
  readonly listScoreEventsInRange: DeploymentsScoringPort["listScoreEventsInRange"] = (...args) =>
    this.scoring.listScoreEventsInRange(...args);
  readonly listInboxEventsInRange: DeploymentsScoringPort["listInboxEventsInRange"] = (...args) =>
    this.scoring.listInboxEventsInRange(...args);

  // ── DeploymentsCompositePort ────────────────────────────────────
  readonly listCompositeTargets: DeploymentsCompositePort["listCompositeTargets"] = (...args) =>
    this.composite.listCompositeTargets(...args);
  readonly putCompositeParent: DeploymentsCompositePort["putCompositeParent"] = (...args) =>
    this.composite.putCompositeParent(...args);
  readonly putCompositeTarget: DeploymentsCompositePort["putCompositeTarget"] = (...args) =>
    this.composite.putCompositeTarget(...args);
  readonly casCompositeParentStatus: DeploymentsCompositePort["casCompositeParentStatus"] = (
    ...args
  ) => this.composite.casCompositeParentStatus(...args);
  readonly failCompositeTargetIfPending: DeploymentsCompositePort["failCompositeTargetIfPending"] =
    (...args) => this.composite.failCompositeTargetIfPending(...args);
  readonly markCompositeParentDeleting: DeploymentsCompositePort["markCompositeParentDeleting"] = (
    ...args
  ) => this.composite.markCompositeParentDeleting(...args);
  readonly forEachCompositeDeployReconcilablePage: DeploymentsCompositePort["forEachCompositeDeployReconcilablePage"] =
    (...args) => this.composite.forEachCompositeDeployReconcilablePage(...args);
  readonly forEachCompositeTeardownPendingPage: DeploymentsCompositePort["forEachCompositeTeardownPendingPage"] =
    (...args) => this.composite.forEachCompositeTeardownPendingPage(...args);

  // ── DeploymentsCoordinationPort ─────────────────────────────────
  readonly readCoordinationState: DeploymentsCoordinationPort["readCoordinationState"] = (
    ...args
  ) => this.coordination.readCoordinationState(...args);
  readonly writeCoordinationState: DeploymentsCoordinationPort["writeCoordinationState"] = (
    ...args
  ) => this.coordination.writeCoordinationState(...args);
}
