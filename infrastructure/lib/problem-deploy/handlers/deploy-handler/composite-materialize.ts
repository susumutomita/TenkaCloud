/**
 * [Composite Runtime / Issue #2063] Materialize a validated composite plan into
 * persisted parent + per-target deployment jobs.
 *
 * Persistence orchestration ONLY. This module turns a deterministic
 * {@link CompositeDeploymentPlan} into one composite parent coordination row and
 * one independent target row per plan target, all addressed by the repository
 * from #2061. It does NOT invoke adapters, publish EventBridge events, assume
 * cloud roles, issue credentials, or mutate status after creation — and it
 * imports no AWS SDK client, EventBridge client, adapter, `fetch`, or credential
 * store. Every side-effecting collaborator (the repository's `ddb` client, the
 * id / key factories, the clock) is injected, so equal inputs and equal injected
 * factories yield the same ids.
 *
 * Ordering / determinism: the clock and the team-login-key factory are read
 * exactly once; the id factory is called once for the parent, then once per
 * target in plan order.
 *
 * Atomicity (issue #2063): the parent is created before any target, so a parent
 * failure aborts before a single target is attempted. A target failure leaves
 * already-created rows in place (no compensation in this issue) and throws a
 * {@link CompositeMaterializationError} naming the parent and the failed target.
 * Idempotent retry of a known target row is the repository's responsibility
 * (#2061), not this function's — calling again with fresh ids creates a new
 * composite deployment.
 */

import type {
  CompositeDeploymentPlan,
  CompositeRuntimeDescriptor,
} from "@tenkacloud/problem-runtime";
import {
  type CompositeDeploymentRepositoryDeps,
  createCompositeParent,
  createCompositeTarget,
} from "./composite-repository.js";

/**
 * Default job TTL. Mirrors the deploy-handler single path
 * (`deploy.ts` `DEFAULT_TTL_MS` = 8h) so composite target rows — which are
 * ordinary deployment rows — expire on the same schedule as a single deploy.
 */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * Account-group fields copied from the existing deploy request onto every target
 * row. Provider / engine / entry are NOT here — they come per-target from the
 * plan. The optional credential fields are forwarded only when present so an AWS
 * target row stays byte-identical to the legacy shape when none are supplied.
 */
export interface CompositeMaterializationAccount {
  readonly awsAccountId: string;
  readonly region: string;
  readonly namePrefix: string;
  readonly competitorRoleArn?: string;
  readonly externalIdParameterName?: string;
  readonly displayTeamName?: string;
}

export interface MaterializeCompositeDeploymentInput {
  /** Repository dependencies (injected `ddb` client + table name). */
  readonly repo: CompositeDeploymentRepositoryDeps;
  /** Validated descriptor — cross-checked against the plan before any write. */
  readonly runtime: CompositeRuntimeDescriptor;
  /** Deterministic plan from {@link buildCompositeDeploymentPlan} (#2062). */
  readonly plan: CompositeDeploymentPlan;
  readonly tenantId: string;
  readonly problemId: string;
  readonly teamName: string;
  readonly account: CompositeMaterializationAccount;
  /** ULID factory: called once for the parent, then once per target in order. */
  readonly newDeploymentId: () => string;
  /** Team-login-key factory: called once; copied to every target row. */
  readonly newTeamLoginKey: () => string;
  /** Clock (epoch ms): read once for `createdAt` + expiry. */
  readonly now: () => number;
  /** Override the {@link DEFAULT_TTL_MS} job TTL (epoch-ms span). */
  readonly ttlMs?: number;
}

export interface MaterializeCompositeDeploymentResult {
  readonly parentDeploymentId: string;
  readonly teamLoginKey: string;
  /** `targetId` → generated `targetDeploymentId`, in plan order. */
  readonly targetDeploymentIds: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

/** Raised when a target row fails to persist; names the parent + failed target. */
export class CompositeMaterializationError extends Error {
  constructor(
    public readonly parentDeploymentId: string,
    public readonly targetId: string,
    public readonly cause: unknown,
  ) {
    super(
      `composite materialization failed for target ${targetId} under parent ${parentDeploymentId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CompositeMaterializationError";
  }
}

/**
 * Defensive cross-check: the plan must have been derived from this descriptor.
 * A mismatch is an upstream programming error (a plan built from a different
 * descriptor), so we fail loudly BEFORE any DynamoDB write rather than persist a
 * silently-wrong composite.
 */
function assertPlanMatchesDescriptor(
  plan: CompositeDeploymentPlan,
  runtime: CompositeRuntimeDescriptor,
): void {
  if (plan.targets.length !== runtime.targets.length) {
    throw new RangeError(
      `composite plan target count ${plan.targets.length} does not match descriptor ${runtime.targets.length}`,
    );
  }
  const declared = new Set(runtime.targets.map((target) => target.id));
  for (const target of plan.targets) {
    if (!declared.has(target.targetId)) {
      throw new RangeError(
        `composite plan target ${target.targetId} is absent from the descriptor`,
      );
    }
  }
}

/**
 * Persist a composite deployment: one parent coordination row + one independent
 * target row per plan target. No cloud resources are started — see module docs.
 */
export async function materializeCompositeDeployment(
  input: MaterializeCompositeDeploymentInput,
): Promise<MaterializeCompositeDeploymentResult> {
  assertPlanMatchesDescriptor(input.plan, input.runtime);

  const nowMs = input.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + (input.ttlMs ?? DEFAULT_TTL_MS));
  const teamLoginKey = input.newTeamLoginKey();
  const parentDeploymentId = input.newDeploymentId();

  // 1. Parent first. If this throws, no target creation is attempted.
  await createCompositeParent(input.repo, {
    parentDeploymentId,
    tenantId: input.tenantId,
    problemId: input.problemId,
    targetCount: input.plan.targets.length,
    createdAt,
    expiresAt,
    status: "PENDING",
  });

  // 2. One independent target row per plan target, in declared order. A failure
  //    at ordinal N leaves rows 0..N-1 in place (no compensation in this issue).
  const targetDeploymentIds: Record<string, string> = {};
  for (const target of input.plan.targets) {
    const targetDeploymentId = input.newDeploymentId();
    try {
      await createCompositeTarget(input.repo, {
        targetDeploymentId,
        parentDeploymentId,
        targetId: target.targetId,
        targetOrdinal: target.targetOrdinal,
        tenantId: input.tenantId,
        problemId: input.problemId,
        provider: target.provider,
        engine: target.engine,
        entry: target.entry,
        awsAccountId: input.account.awsAccountId,
        region: input.account.region,
        teamName: input.teamName,
        namePrefix: input.account.namePrefix,
        teamLoginKey,
        createdAt,
        expiresAt,
        status: "PENDING",
        ...(input.account.competitorRoleArn
          ? { competitorRoleArn: input.account.competitorRoleArn }
          : {}),
        ...(input.account.externalIdParameterName
          ? { externalIdParameterName: input.account.externalIdParameterName }
          : {}),
        ...(input.account.displayTeamName
          ? { displayTeamName: input.account.displayTeamName }
          : {}),
      });
    } catch (cause) {
      throw new CompositeMaterializationError(parentDeploymentId, target.targetId, cause);
    }
    targetDeploymentIds[target.targetId] = targetDeploymentId;
  }

  return { parentDeploymentId, teamLoginKey, targetDeploymentIds, expiresAt };
}
