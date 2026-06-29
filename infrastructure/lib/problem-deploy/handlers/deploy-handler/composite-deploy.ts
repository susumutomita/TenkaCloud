/**
 * [Composite Runtime / Issue #2075] Route a `runtime.kind=composite` deploy
 * request through materialization (#2063) then per-target dispatch (#2066).
 *
 * This is the ONLY new entry point for composite problems. Legacy and explicit
 * single-provider problems never reach here — the deploy route keeps calling the
 * untouched `startDeployment` for them, so their EventBridge detail, persisted
 * DDB row, and HTTP response stay byte-identical (the #2059 compat suite pins
 * exactly that).
 *
 * Contract (issue #2075):
 *   - Resolve the deterministic plan from the composite descriptor BEFORE any
 *     write, so a malformed descriptor fails loudly with no side effect.
 *   - Enforce the deploy quota ONCE per composite parent (not once per target).
 *   - AWS account + region are required only when the plan contains an AWS
 *     target; an Azure/GCP/Sakura-only composite needs neither.
 *   - Materialize the parent + N target rows. If materialization fails, return
 *     the error and dispatch NOTHING.
 *   - After materialization, dispatch every target. Return the PARENT response
 *     (jobId = parentDeploymentId) even when one or more target dispatches fail —
 *     per-target failure lives in the target rows + parent reconciliation, not in
 *     the parent HTTP response.
 *   - Emit one parent-level audit event and one dispatch audit record per target.
 *   - The response reuses the existing single-provider shape; no new required
 *     field is added.
 *
 * Every collaborator (plan builder, quota enforcer, materialize, dispatch) is
 * injected, so the handler test runs without a real cloud, real DynamoDB, or
 * real EventBridge.
 */

import type {
  CompositeDeploymentPlan,
  CompositeRuntimeDescriptor,
} from "../shared/runtime/index.js";
import { logDeployTrace } from "../shared/trace-log.js";
import type {
  CompositeDispatchResult,
  CompositeTargetDispatchResult,
} from "./composite-dispatch.js";
import type {
  MaterializeCompositeDeploymentInput,
  MaterializeCompositeDeploymentResult,
} from "./composite-materialization.js";
import type { QuotaTier } from "./deploy-quota.js";
import { buildStackPrefix } from "./naming.js";
import type { DeployResponse } from "./types.js";

/** The composite deploy request, already authorized + validated at the route. */
export interface CompositeDeployInvocation {
  readonly problemId: string;
  readonly descriptor: CompositeRuntimeDescriptor;
  readonly teamName: string;
  /**
   * Competitor AWS account + region. Required only when the plan has an AWS
   * target (the route enforces this before calling); optional otherwise.
   */
  readonly awsAccountId?: string;
  readonly region?: string;
  readonly accountGroupId?: string;
  readonly problemSetId?: string;
  /** Resolved quota tier (JWT claim), defaults to the strictest tier upstream. */
  readonly quotaTier: QuotaTier;
}

/** Injected collaborators so the orchestration never reaches a real cloud. */
export interface CompositeDeployDeps {
  /** Deterministic plan builder (#2062). */
  readonly buildPlan: (descriptor: CompositeRuntimeDescriptor) => CompositeDeploymentPlan;
  /**
   * Enforce the tenant's deploy quota ONCE for the whole composite parent.
   * Throws `DeployQuotaExceededError` when the tenant is at its limit.
   */
  readonly enforceQuota: (tenantId: string, tier: QuotaTier) => Promise<void>;
  /** Persist the parent + target rows (#2063). */
  readonly materialize: (
    input: MaterializeCompositeDeploymentInput,
  ) => Promise<MaterializeCompositeDeploymentResult>;
  /** Start every materialized target through its adapter (#2066). */
  readonly dispatch: (parentDeploymentId: string) => Promise<CompositeDispatchResult>;
  /** Tenant id resolved from the request context (Cognito JWT claim). */
  readonly tenantId: string;
}

/**
 * Raised when a composite plan needs an AWS account/region (it has an AWS
 * target) but the request did not supply them. The route maps it to a 400.
 */
export class CompositeAwsInputRequiredError extends Error {
  constructor() {
    super("composite plan includes an AWS target but awsAccountId/region are missing");
    this.name = "CompositeAwsInputRequiredError";
  }
}

/** True when the plan contains at least one AWS target. */
export function planHasAwsTarget(plan: CompositeDeploymentPlan): boolean {
  return plan.targets.some((target) => target.provider === "aws");
}

function emitParentAudit(
  deps: CompositeDeployDeps,
  parentDeploymentId: string,
  problemId: string,
  targetCount: number,
): void {
  logDeployTrace("composite.deploy.parent.enqueued", {
    parentDeploymentId,
    correlationId: parentDeploymentId,
    tenantId: deps.tenantId,
    problemId,
    targetCount,
    runtimeKind: "composite",
  });
}

function emitTargetDispatchAudit(
  deps: CompositeDeployDeps,
  parentDeploymentId: string,
  target: CompositeTargetDispatchResult,
): void {
  logDeployTrace("composite.deploy.target.dispatched", {
    parentDeploymentId,
    correlationId: parentDeploymentId,
    tenantId: deps.tenantId,
    targetId: target.targetId,
    targetDeploymentId: target.targetDeploymentId,
    outcome: target.outcome,
  });
}

/**
 * Route a composite deploy request through materialization + target dispatch.
 * See module docs for the full contract. `adapter` typing only references the
 * `deploy` capability so callers cannot accidentally pass a non-deploy seam.
 */
export async function startCompositeDeployment(
  deps: CompositeDeployDeps,
  request: CompositeDeployInvocation,
): Promise<DeployResponse> {
  // 1. Plan first — a malformed composite descriptor fails here, before any
  //    quota check, persistence, audit, or dispatch.
  const plan = deps.buildPlan(request.descriptor);

  // 2. AWS account/region are required only when the plan has an AWS target.
  if (planHasAwsTarget(plan) && (!request.awsAccountId || !request.region)) {
    throw new CompositeAwsInputRequiredError();
  }

  // 3. Authorization is enforced by the route (Cognito JWT + role). The deploy
  //    quota is enforced ONCE for the whole parent — never once per target.
  await deps.enforceQuota(deps.tenantId, request.quotaTier);

  const namePrefix = buildStackPrefix(request.problemId, request.teamName);

  // 4. Materialize the parent + target rows. A failure here propagates and
  //    NOTHING is dispatched (the catch is intentionally absent — the error is
  //    the signal "do not dispatch").
  const materialized = await deps.materialize({
    plan,
    tenantId: deps.tenantId,
    problemId: request.problemId,
    teamName: request.teamName,
    // Non-AWS-only composites carry empty strings here; target rows for non-AWS
    // providers ignore them (the per-team connection drives those), and there is
    // no AWS target to consume them.
    awsAccountId: request.awsAccountId ?? "",
    region: request.region ?? "",
    namePrefix,
    ...(request.accountGroupId ? { accountGroupId: request.accountGroupId } : {}),
    ...(request.problemSetId ? { problemSetId: request.problemSetId } : {}),
  });

  // 5. One parent-level audit event.
  emitParentAudit(deps, materialized.parentDeploymentId, request.problemId, plan.targets.length);

  // 6. Dispatch every target. A per-target failure is recorded in its row (by
  //    #2066) — it never aborts the parent response.
  const dispatched = await deps.dispatch(materialized.parentDeploymentId);
  for (const target of dispatched.targets) {
    emitTargetDispatchAudit(deps, materialized.parentDeploymentId, target);
  }

  // 7. Parent response reuses the existing single-provider shape; jobId is the
  //    parent deployment id. No new required field.
  return {
    jobId: materialized.parentDeploymentId,
    status: "PENDING",
    namePrefix,
    teamLoginKey: materialized.teamLoginKey,
    expiresAt: materialized.expiresAt,
  };
}
