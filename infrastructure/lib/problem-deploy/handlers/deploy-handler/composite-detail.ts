/**
 * [Composite Runtime / Issues #2073, #2747] Operator-facing Composite target view.
 *
 * Dependency metadata is projected without bound values. Legacy targets that predate #2747 keep
 * the version-1 byte shape; dataflow fields are added only when a target row actually carries the
 * persisted graph contract.
 */

import { z } from "zod";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { CompositeOutputsError } from "./composite-outputs.js";
import {
  type CompositeDeploymentRepositoryDeps,
  type CompositeTargetDeploymentRecord,
  listCompositeTargets,
} from "./composite-repository.js";
import { DeploymentStatusSchema } from "./types.js";

export const COMPOSITE_DETAIL_VERSION = 1 as const;
export const COMPOSITE_TARGET_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;
export type CompositeTargetProvider = (typeof COMPOSITE_TARGET_PROVIDERS)[number];
export const COMPOSITE_DEPENDENCY_STATES = [
  "ready",
  "waiting",
  "running",
  "complete",
  "blocked",
] as const;
export type CompositeDependencyState = (typeof COMPOSITE_DEPENDENCY_STATES)[number];

export const CompositeTargetSummarySchema = z.object({
  targetId: z.string(),
  targetDeploymentId: z.string(),
  ordinal: z.number().int().nonnegative(),
  provider: z.enum(COMPOSITE_TARGET_PROVIDERS),
  engine: z.string(),
  status: DeploymentStatusSchema,
  updatedAt: z.string(),
  failureReason: z.string().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  executionWave: z.number().int().nonnegative().optional(),
  dependencyState: z.enum(COMPOSITE_DEPENDENCY_STATES).optional(),
  dependsOn: z.array(z.string()).readonly().optional(),
  inputParameters: z.array(z.string()).readonly().optional(),
});
export type CompositeTargetSummary = z.infer<typeof CompositeTargetSummarySchema>;

export const CompositeDetailSchema = z.object({
  version: z.literal(COMPOSITE_DETAIL_VERSION),
  targets: z.array(CompositeTargetSummarySchema).readonly(),
});
export type CompositeDetail = z.infer<typeof CompositeDetailSchema>;

function isMalformedOutputJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

function normalizeProvider(raw: string): CompositeTargetProvider {
  return (COMPOSITE_TARGET_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as CompositeTargetProvider)
    : "aws";
}

function dependenciesOf(target: CompositeTargetDeploymentRecord): readonly string[] {
  return Array.isArray(target.compositeDependsOn) ? target.compositeDependsOn : [];
}

function dependencyState(
  target: CompositeTargetDeploymentRecord,
  byId: ReadonlyMap<string, CompositeTargetDeploymentRecord>,
): CompositeDependencyState {
  if (target.status === "COMPLETE") return "complete";
  if (["FAILED", "DELETING", "DELETED", "EXPIRED", "AUTO_DELETED"].includes(target.status)) {
    return "blocked";
  }
  if (target.status !== "PENDING") return "running";
  const dependencies = dependenciesOf(target);
  if (dependencies.some((targetId) => byId.get(targetId)?.status === "FAILED")) return "blocked";
  if (dependencies.some((targetId) => byId.get(targetId)?.status !== "COMPLETE")) return "waiting";
  return "ready";
}

function hasDataflowMetadata(target: CompositeTargetDeploymentRecord): boolean {
  return (
    target.compositeExecutionWave !== undefined ||
    target.compositeDependsOn !== undefined ||
    target.compositeInputs !== undefined ||
    target.compositeOutputs !== undefined
  );
}

export async function buildCompositeDetail(
  deps: CompositeDeploymentRepositoryDeps,
  parentDeploymentId: string,
): Promise<CompositeDetail> {
  const targets = await listCompositeTargets(deps, parentDeploymentId);
  const byId = new Map(targets.map((target) => [target.targetId, target]));

  const summaries: CompositeTargetSummary[] = targets.map((target) => {
    const raw = target.stackOutputs;
    if (raw && isMalformedOutputJson(raw)) {
      throw new CompositeOutputsError(parentDeploymentId, target.targetId, "malformed output JSON");
    }
    const outputs = parseStackOutputs(raw);
    const dataflow = hasDataflowMetadata(target);

    return {
      targetId: target.targetId,
      targetDeploymentId: target.jobId,
      ordinal: target.targetOrdinal,
      provider: normalizeProvider(target.runtimeProvider),
      engine: target.runtimeEngine,
      status: target.status,
      updatedAt: target.updatedAt,
      ...(target.failureReason ? { failureReason: target.failureReason } : {}),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      ...(dataflow
        ? {
            executionWave: target.compositeExecutionWave ?? 0,
            dependencyState: dependencyState(target, byId),
            dependsOn: [...dependenciesOf(target)],
            inputParameters: Object.keys(target.compositeInputs ?? {}).sort(),
          }
        : {}),
    };
  });

  return { version: COMPOSITE_DETAIL_VERSION, targets: summaries };
}
