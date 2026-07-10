/**
 * [Composite Runtime / Issue #2081] Offline-safe Composite acceptance harness.
 *
 * Drives the FULL Composite parent/child lifecycle end to end by COMPOSING the
 * real, already-merged Composite modules — never a re-implementation:
 *
 *   register/verify connection  → resolveCompositeTargetConnection (#2065)
 *   start composite deploy      → startCompositeDeployment (#2075)
 *     ├─ materialize parent + N target rows → materializeCompositeDeployment (#2063)
 *     └─ ordered per-target dispatch        → dispatchCompositeDeployment (#2066)
 *   status progression          → reconcileCompositeParentDeployStatus (#2067/#2068)
 *   namespaced outputs          → collectCompositeOutputs (#2069)
 *   composite scoring           → scoreCompositeProbe (#2070)
 *   teardown fan-out            → requestCompositeTeardown (#2071)
 *   teardown completion         → reconcileCompositeParentTeardown (#2072)
 *
 * The ONLY doubles are the provider TRANSPORTS (the per-provider deploy adapter,
 * the connection resolver, the per-target teardown, the HTTPS probe) and the
 * persistence client (an in-memory DynamoDB double). Every line of orchestration,
 * aggregation, namespacing, and scoring under test is the production code. The
 * harness therefore exercises the real contracts with NO real cloud, NO network,
 * and NO provider SDK credentials — which is exactly the part of issue #2081 that
 * is verifiable in CI (CI has no cloud accounts and never deploys).
 *
 * It also models the four required failure-injection classes as first-class knobs
 * (a connection preflight failure, a dispatch failure, a mid-flight target status
 * failure, and a teardown failure), so a single driver proves both the happy path
 * AND that per-target failure reason + retryability stay visible while the parent
 * state aggregates correctly.
 *
 * Redaction: the harness captures every structured log line it (and the modules it
 * drives) emit, so a caller can assert that no credential / secret / token ever
 * lands in a record or a log. The harness itself only ever transports the
 * secret-free identifiers the production modules already expose.
 */

import {
  buildCompositeDeploymentPlan,
  type CompositeRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import type { CompositeProbeScoringMetadata } from "../../../utils/scoring-metadata.js";
import {
  type CompositeDeployDeps,
  type CompositeDeployInvocation,
  startCompositeDeployment,
} from "../deploy-handler/composite-deploy.js";
import {
  type CompositeDispatchResult,
  dispatchCompositeDeployment,
} from "../deploy-handler/composite-dispatch.js";
import {
  type MaterializeCompositeDeploymentInput,
  materializeCompositeDeployment,
} from "../deploy-handler/composite-materialization.js";
import { collectCompositeOutputs } from "../deploy-handler/composite-outputs.js";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
  getCompositeParent,
  listCompositeTargets,
} from "../deploy-handler/composite-repository.js";
import type {
  ResolveCompositeTargetConnectionInput,
  TargetConnection,
} from "../deploy-handler/composite-target-connection.js";
import {
  type CompositeTeardownResult,
  requestCompositeTeardown,
} from "../deploy-handler/composite-teardown.js";
import type { TeardownOutcome } from "../deploy-handler/delete.js";
import { slugify } from "../deploy-handler/naming.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import {
  type CompositeParentReconcileDeps,
  reconcileCompositeParentDeployStatus,
} from "../generic-scoring-handler/composite-status-reconciler.js";
import { reconcileCompositeParentTeardown } from "../generic-scoring-handler/composite-teardown-reconciler.js";
import {
  type CompositeProbeFn,
  type CompositeProbeInput,
  type CompositeProbeScoreResult,
  type CompositeTargetProvider,
  scoreCompositeProbe,
} from "../generic-scoring-handler/kinds/composite-probe.js";
import type { ProblemRuntimeAdapter } from "../shared/runtime/adapter.js";

/** A provider transport double — the only seam allowed to stand in for a cloud. */
export interface ProviderTransport {
  /** Per-target deploy adapter (the production dispatch calls `.deploy`). */
  readonly adapter: Pick<ProblemRuntimeAdapter, "deploy">;
  /**
   * Preflight connection resolver. Returning a {@link TargetConnection} models a
   * verified per-team connection; throwing models a preflight failure (#2065).
   */
  readonly resolveConnection: (
    input: ResolveCompositeTargetConnectionInput,
  ) => Promise<TargetConnection>;
  /** Per-target teardown transport (the production fan-out calls this). */
  readonly teardownTarget: (targetDeploymentId: string) => Promise<TeardownOutcome>;
  /** HTTPS probe used by composite scoring (the production scorer calls this). */
  readonly probe: CompositeProbeFn;
}

/** One target the harness will drive, in declared (ordinal) order. */
export interface AcceptanceTarget {
  readonly targetId: string;
  readonly ordinal: number;
  readonly provider: CompositeTargetProvider;
  readonly engine: string;
  readonly entry: string;
  /** The runtime output key the scorer reads for this target. */
  readonly outputKey: string;
  /** The URL this target exposes once COMPLETE (for outputs + scoring). */
  readonly url: string;
}

/** A single captured structured log line (event + redaction-checkable payload). */
export interface CapturedLog {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

export interface CompositeAcceptanceConfig {
  readonly parentDeploymentId: string;
  readonly tenantId: string;
  readonly problemId: string;
  readonly problemDir: string;
  readonly teamName: string;
  readonly teamLoginKey: string;
  readonly awsAccountId: string;
  readonly region: string;
  readonly nowMs: number;
  readonly descriptor: CompositeRuntimeDescriptor;
  readonly scoring: CompositeProbeScoringMetadata;
  readonly targets: readonly AcceptanceTarget[];
  readonly transport: ProviderTransport;
  /** Repository deps over the in-memory persistence double. */
  readonly repo: CompositeDeploymentRepositoryDeps;
  /** Reconcile deps over the SAME persistence double. */
  readonly reconcileDeps: CompositeParentReconcileDeps;
  /** Read a deployment row's current status from the persistence double. */
  readonly readStatus: (deploymentId: string) => DeploymentStatus | undefined;
  /** Set a deployment row's status on the persistence double (status injection). */
  readonly setStatus: (deploymentId: string, status: DeploymentStatus) => void;
  /** Set a deployment row's raw stackOutputs JSON on the persistence double. */
  readonly setOutputs: (deploymentId: string, raw: string) => void;
}

/** A per-target preflight verification outcome (secret-free). */
export interface PreflightResult {
  readonly targetId: string;
  readonly provider: CompositeTargetProvider;
  readonly ok: boolean;
  /** Class name only when it failed — never a message that could carry a secret. */
  readonly reason?: string;
  /** Whether a failed preflight is worth retrying (a missing connection is). */
  readonly retryable: boolean;
}

/** The deterministic deployment id the harness assigns each target. */
export function acceptanceTargetDeploymentId(targetId: string): string {
  return `t-${targetId}`;
}

/**
 * A composing acceptance driver. Each method runs ONE real lifecycle phase over
 * the injected doubles and records its structured logs for redaction assertions.
 * The phases are separate so a test can interleave failure injection between them.
 */
export class CompositeAcceptanceHarness {
  private readonly logs: CapturedLog[] = [];

  constructor(private readonly config: CompositeAcceptanceConfig) {}

  /** Every structured log captured so far (for redaction assertions). */
  capturedLogs(): readonly CapturedLog[] {
    return this.logs;
  }

  private record(event: string, payload: Record<string, unknown>): void {
    this.logs.push({ event, payload });
  }

  /**
   * Phase 0 — register / verify every target's per-team connection through the
   * REAL preflight contract shape. A throwing resolver is the connection-preflight
   * failure class; the returned reason is the error class name only (no secret),
   * and a missing connection is reported retryable.
   */
  async verifyConnections(): Promise<readonly PreflightResult[]> {
    const results: PreflightResult[] = [];
    for (const target of this.config.targets) {
      const input = this.connectionInput(target);
      try {
        const connection = await this.config.transport.resolveConnection(input);
        this.record("composite.acceptance.preflight.ok", {
          targetId: target.targetId,
          provider: connection.provider,
        });
        results.push({
          targetId: target.targetId,
          provider: target.provider,
          ok: true,
          retryable: false,
        });
      } catch (err) {
        const reason = nonSecretReason(err);
        this.record("composite.acceptance.preflight.failed", {
          targetId: target.targetId,
          provider: target.provider,
          reason,
        });
        results.push({
          targetId: target.targetId,
          provider: target.provider,
          ok: false,
          reason,
          // A missing / unverified connection is operator-fixable, so retryable.
          retryable: true,
        });
      }
    }
    return results;
  }

  /**
   * Phase 1 — start the composite deploy through the REAL deploy router, which
   * materializes the parent + N target rows and dispatches every target in
   * declared order. The dispatch result surfaces per-target outcome so a caller
   * can see exactly which target failed.
   */
  async startDeploy(): Promise<{
    readonly parentDeploymentId: string;
    readonly dispatch: CompositeDispatchResult;
  }> {
    let idCounter = 0;
    const newDeploymentId = (): string => {
      if (idCounter === 0) {
        idCounter += 1;
        return this.config.parentDeploymentId;
      }
      const target = this.config.targets[idCounter - 1];
      idCounter += 1;
      return acceptanceTargetDeploymentId(target.targetId);
    };

    const materialize = (input: MaterializeCompositeDeploymentInput) =>
      materializeCompositeDeployment(
        {
          createParent: (p) => createCompositeParent(this.config.repo, p),
          createTarget: (t) => createCompositeTarget(this.config.repo, t),
          newDeploymentId,
          newTeamLoginKey: () => this.config.teamLoginKey,
          now: () => this.config.nowMs,
        },
        input,
      );

    let dispatch: CompositeDispatchResult = {
      parentDeploymentId: this.config.parentDeploymentId,
      targets: [],
    };
    const deps: CompositeDeployDeps = {
      buildPlan: buildCompositeDeploymentPlan,
      enforceQuota: async () => {},
      materialize,
      dispatch: async (parentDeploymentId) => {
        dispatch = await dispatchCompositeDeployment(
          {
            repo: this.config.repo,
            resolveConnection: this.config.transport.resolveConnection,
            selectAdapter: () => this.config.transport.adapter,
            problemsCatalog: { [this.config.problemId]: this.config.problemDir },
            now: () => this.config.nowMs,
          },
          parentDeploymentId,
        );
        return dispatch;
      },
      tenantId: this.config.tenantId,
    };

    const invocation: CompositeDeployInvocation = {
      problemId: this.config.problemId,
      descriptor: this.config.descriptor,
      teamName: this.config.teamName,
      awsAccountId: this.config.awsAccountId,
      region: this.config.region,
      quotaTier: "basic",
    };

    const response = await startCompositeDeployment(deps, invocation);
    for (const target of dispatch.targets) {
      this.record("composite.acceptance.dispatch.target", {
        targetId: target.targetId,
        outcome: target.outcome,
      });
    }
    return { parentDeploymentId: response.jobId, dispatch };
  }

  /**
   * Phase 2 — re-derive the parent status from its targets through the REAL
   * deploy-status reconciler. Returns the freshly written parent status so a
   * caller can pin PENDING → IN_PROGRESS → COMPLETE (or FAILED) progression.
   */
  async reconcileParentStatus(): Promise<DeploymentStatus> {
    const result = await reconcileCompositeParentDeployStatus(this.config.reconcileDeps, {
      parentDeploymentId: this.config.parentDeploymentId,
      nowIso: new Date(this.config.nowMs).toISOString(),
    });
    this.record("composite.acceptance.reconcile.deploy", {
      parentDeploymentId: this.config.parentDeploymentId,
      previousStatus: result.previousStatus,
      nextStatus: result.nextStatus,
    });
    return result.nextStatus;
  }

  /**
   * Mark one target COMPLETE and publish the URL it exposes, so the outputs +
   * scoring phases have real persisted state to read. (A test can instead use
   * {@link CompositeAcceptanceConfig.setStatus} to inject a mid-flight FAILED.)
   */
  completeTarget(target: AcceptanceTarget): void {
    const id = acceptanceTargetDeploymentId(target.targetId);
    this.config.setStatus(id, "COMPLETE");
    this.config.setOutputs(id, JSON.stringify({ [target.outputKey]: target.url }));
  }

  /** Phase 3 — assemble the target-namespaced output view via the REAL collector. */
  async collectOutputs() {
    return collectCompositeOutputs(this.config.repo, this.config.parentDeploymentId);
  }

  /**
   * Phase 4 — score the composite through the REAL composite-probe scorer over the
   * persisted per-target view, using the injected HTTPS probe transport.
   */
  async score(): Promise<CompositeProbeScoreResult> {
    const targets = await listCompositeTargets(this.config.repo, this.config.parentDeploymentId);
    const outputs = await collectCompositeOutputs(this.config.repo, this.config.parentDeploymentId);
    const parent = await getCompositeParent(this.config.repo, this.config.parentDeploymentId);
    const input: CompositeProbeInput = {
      parentDeploymentId: this.config.parentDeploymentId,
      parentStatus: (parent?.status ?? "PENDING") as DeploymentStatus,
      targets: [...targets]
        .sort((a, b) => a.targetOrdinal - b.targetOrdinal)
        .map((row) => ({
          targetId: row.targetId,
          provider: row.runtimeProvider as CompositeTargetProvider,
          status: row.status,
          outputs: outputs[row.targetId] ?? {},
        })),
    };
    const result = await scoreCompositeProbe(
      input,
      this.config.scoring,
      this.config.transport.probe,
    );
    this.record("composite.acceptance.score", {
      parentDeploymentId: this.config.parentDeploymentId,
      success: result.success,
      pointsAwarded: result.pointsAwarded,
      failureTargetIds: result.data.failures.map((f) => f.targetId),
    });
    return result;
  }

  /**
   * Phase 5 — request teardown for every eligible target through the REAL fan-out,
   * flipping the parent to DELETING. The injected teardown transport may throw /
   * return a failure for one target (the teardown-failure class), and the fan-out
   * never short-circuits the remaining targets.
   */
  async requestTeardown(): Promise<CompositeTeardownResult> {
    const result = await requestCompositeTeardown(
      {
        repo: this.config.repo,
        teardownTarget: this.config.transport.teardownTarget,
        now: () => this.config.nowMs,
      },
      { parentDeploymentId: this.config.parentDeploymentId, tenantId: this.config.tenantId },
    );
    for (const target of result.targets) {
      this.record("composite.acceptance.teardown.target", {
        targetId: target.targetId,
        outcome: target.outcome,
      });
    }
    return result;
  }

  /**
   * Phase 6 — finalize the parent to DELETED through the REAL teardown-completion
   * reconciler, but only once every target is deleted-like. Returns the parent
   * status after the reconcile.
   */
  async reconcileTeardown(): Promise<DeploymentStatus> {
    const result = await reconcileCompositeParentTeardown(
      {
        runtime: this.config.reconcileDeps.runtime,
        ddb: this.config.reconcileDeps.ddb,
        deploymentsTableName: this.config.reconcileDeps.deploymentsTableName,
      },
      {
        parentDeploymentId: this.config.parentDeploymentId,
        nowIso: new Date(this.config.nowMs).toISOString(),
      },
    );
    this.record("composite.acceptance.reconcile.teardown", {
      parentDeploymentId: this.config.parentDeploymentId,
      previousStatus: result.previousStatus,
      nextStatus: result.nextStatus,
    });
    return result.nextStatus;
  }

  /** Build the secret-free preflight input for one target (AWS vs non-AWS shape). */
  private connectionInput(target: AcceptanceTarget): ResolveCompositeTargetConnectionInput {
    if (target.provider === "aws") {
      return {
        provider: "aws",
        tenantId: this.config.tenantId,
        awsAccountId: this.config.awsAccountId,
        region: this.config.region,
      };
    }
    return {
      provider: target.provider,
      tenantId: this.config.tenantId,
      teamSlug: slugify(this.config.teamName),
    };
  }
}

/** Class name only — never an error message, which could carry provider detail. */
function nonSecretReason(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown error";
}
