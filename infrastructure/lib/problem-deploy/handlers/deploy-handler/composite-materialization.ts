/**
 * [Composite Runtime / Issues #2063, #2747] Composite deployment materialization.
 *
 * A validated deterministic plan becomes one parent row and one target row per node. Dependency,
 * binding, output-classification, and execution-wave metadata are immutable target identity: a
 * retry cannot silently change the graph already persisted for a parent.
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

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

export interface MaterializeCompositeDeploymentDeps {
  readonly createParent: (
    input: CreateCompositeParentInput,
  ) => Promise<CompositeParentDeploymentItem>;
  readonly createTarget: (
    input: CreateCompositeTargetInput,
  ) => Promise<CompositeTargetDeploymentItem>;
  readonly newDeploymentId: () => string;
  readonly newTeamLoginKey: () => string;
  readonly now: () => number;
  readonly ttlMs?: number;
}

export interface MaterializeCompositeDeploymentInput {
  readonly plan: CompositeDeploymentPlan;
  readonly tenantId: string;
  readonly problemId: string;
  readonly teamName: string;
  readonly awsAccountId: string;
  readonly region: string;
  readonly accountGroupId?: string;
  readonly problemSetId?: string;
  readonly namePrefix: string;
}

export interface MaterializeCompositeDeploymentResult {
  readonly parentDeploymentId: string;
  readonly teamLoginKey: string;
  readonly targetDeploymentIds: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

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

export async function materializeCompositeDeployment(
  deps: MaterializeCompositeDeploymentDeps,
  input: MaterializeCompositeDeploymentInput,
): Promise<MaterializeCompositeDeploymentResult> {
  const nowMs = deps.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = toEpochSeconds(nowMs + (deps.ttlMs ?? DEFAULT_TTL_MS));
  const teamLoginKey = deps.newTeamLoginKey();
  const parentDeploymentId = deps.newDeploymentId();

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
    accountGroupId: input.accountGroupId,
    problemSetId: input.problemSetId,
  });

  const targetDeploymentIds: Record<string, string> = {};
  for (const target of input.plan.targets) {
    const targetDeploymentId = deps.newDeploymentId();
    try {
      await deps.createTarget({
        targetDeploymentId,
        parentDeploymentId,
        targetId: target.targetId,
        targetOrdinal: target.targetOrdinal,
        executionWave: target.executionWave,
        dependsOn: target.dependsOn,
        inputs: target.inputs,
        outputs: target.outputs,
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
        accountGroupId: input.accountGroupId,
        problemSetId: input.problemSetId,
      });
    } catch (error) {
      throw new CompositeMaterializationError(parentDeploymentId, target.targetId, error);
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
