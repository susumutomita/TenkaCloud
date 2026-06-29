/**
 * [Composite Runtime / Issue #2063] Composite deployment materialization.
 *
 * Turns a validated composite deploy request + a deterministic
 * {@link CompositeDeploymentPlan} (#2062) into one persisted parent job and one
 * persisted target job per plan target (via the #2061 repository). It ONLY
 * persists jobs — it never invokes adapters, publishes EventBridge events,
 * assumes cloud roles, issues credentials, or mutates status after creation.
 *
 * Everything non-deterministic is injected (ID factory, team-login-key factory,
 * clock) and the persistence functions are injected too, so this module imports
 * no AWS SDK client, EventBridge client, adapter, fetch, or credential store —
 * it is a pure orchestration over its dependencies.
 *
 * Ordering / failure semantics (issue #2063):
 *   - The parent is created before any target. If the parent write fails, no
 *     target is attempted (the error propagates).
 *   - Targets are created in plan (ordinal) order. If target N fails, targets
 *     0..N-1 are left in place (no cleanup here) and the thrown
 *     {@link CompositeMaterializationError} names the parent + the failed target.
 *   - Each call generates fresh ids — this is not a retry API. Idempotent retry
 *     of a known target row is the repository's responsibility (#2061).
 */

import type { CompositeDeploymentPlan } from "@tenkacloud/problem-runtime";
import type {
  CompositeParentDeploymentItem,
  CompositeTargetDeploymentItem,
} from "./composite-deployment.js";
import type {
  CreateCompositeParentInput,
  CreateCompositeTargetInput,
} from "./composite-repository.js";

/** 8 hours — matches the single-provider deployment session TTL in deploy.ts. */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * Injected dependencies. Persistence is the #2061 repository's create
 * functions; the rest are deterministic factories so tests pin every id / key /
 * timestamp. No concrete AWS / event / adapter dependency appears here.
 */
export interface MaterializeCompositeDeploymentDeps {
  readonly createParent: (
    input: CreateCompositeParentInput,
  ) => Promise<CompositeParentDeploymentItem>;
  readonly createTarget: (
    input: CreateCompositeTargetInput,
  ) => Promise<CompositeTargetDeploymentItem>;
  /** Fresh globally-unique deployment id (e.g. a ULID) per call. */
  readonly newDeploymentId: () => string;
  /** Fresh team-login-key, generated once and shared across parent + targets. */
  readonly newTeamLoginKey: () => string;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Session TTL; defaults to 8h. */
  readonly ttlMs?: number;
}

export interface MaterializeCompositeDeploymentInput {
  readonly plan: CompositeDeploymentPlan;
  readonly tenantId: string;
  readonly problemId: string;
  readonly teamName: string;
  /** Competitor AWS account + region from the deploy request (shared context). */
  readonly awsAccountId: string;
  readonly region: string;
  /** Base stack-name prefix; each target gets `${namePrefix}-${targetId}`. */
  readonly namePrefix: string;
}

export interface MaterializeCompositeDeploymentResult {
  readonly parentDeploymentId: string;
  readonly teamLoginKey: string;
  /** targetId → targetDeploymentId. */
  readonly targetDeploymentIds: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

/** Thrown when a target write fails; names the parent + the failed target. */
export class CompositeMaterializationError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    public readonly failedTargetId: string,
    public readonly reason: unknown,
  ) {
    super(
      `composite materialization failed for parent ${parentDeploymentId} at target ${failedTargetId}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    this.name = "CompositeMaterializationError";
  }
}

/**
 * Materialize a composite deploy request into a parent job + one target job per
 * plan target. See module docs for ordering / failure semantics.
 */
export async function materializeCompositeDeployment(
  deps: MaterializeCompositeDeploymentDeps,
  input: MaterializeCompositeDeploymentInput,
): Promise<MaterializeCompositeDeploymentResult> {
  const nowMs = deps.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + (deps.ttlMs ?? DEFAULT_TTL_MS));
  const teamLoginKey = deps.newTeamLoginKey();
  const parentDeploymentId = deps.newDeploymentId();

  // Parent first. A failure here propagates with no target attempted.
  await deps.createParent({
    parentDeploymentId,
    tenantId: input.tenantId,
    problemId: input.problemId,
    targetCount: input.plan.targets.length,
    createdAt,
    expiresAt,
    status: "PENDING",
    teamName: input.teamName,
    teamLoginKey,
  });

  // Targets in declared (ordinal) order. Partial state is preserved on failure.
  const targetDeploymentIds: Record<string, string> = {};
  for (const target of input.plan.targets) {
    const targetDeploymentId = deps.newDeploymentId();
    try {
      await deps.createTarget({
        targetDeploymentId,
        parentDeploymentId,
        targetId: target.targetId,
        targetOrdinal: target.targetOrdinal,
        tenantId: input.tenantId,
        problemId: input.problemId,
        provider: target.provider,
        engine: target.engine,
        entry: target.entry,
        awsAccountId: input.awsAccountId,
        region: input.region,
        teamName: input.teamName,
        namePrefix: `${input.namePrefix}-${target.targetId}`,
        teamLoginKey,
        createdAt,
        expiresAt,
        status: "PENDING",
      });
    } catch (err) {
      throw new CompositeMaterializationError(parentDeploymentId, target.targetId, err);
    }
    targetDeploymentIds[target.targetId] = targetDeploymentId;
  }

  return {
    parentDeploymentId,
    teamLoginKey,
    targetDeploymentIds: Object.freeze(targetDeploymentIds),
    expiresAt,
  };
}
