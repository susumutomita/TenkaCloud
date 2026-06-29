/**
 * [Composite Runtime / Issue #2073] Operator-facing composite target status view
 * for the deployment-detail API.
 *
 * `buildCompositeDetail` reads a composite parent's target rows through the #2061
 * repository (GSI3, ordinal order) and projects each target down to a strictly
 * whitelisted summary so an operator can see per-target status on the existing
 * deployment-detail response — WITHOUT ever exposing provider credentials, role
 * ARNs, ExternalId / SSM parameter names, login keys, or any raw provider
 * configuration. Only the fields enumerated in {@link CompositeTargetSummary}
 * leave this module.
 *
 * Outputs are parsed only through the existing fail-safe {@link parseStackOutputs}
 * rules. As in {@link collectCompositeOutputs} (#2069), a target whose
 * `stackOutputs` string is present but is not valid JSON is surfaced as a typed
 * {@link CompositeOutputsError} (parent + target identity) rather than returning
 * partial data — the caller maps that to a controlled HTTP 500.
 *
 * This module is read-only and additive: it never mutates a row, never starts a
 * deployment, and only the composite-parent detail path calls it. Legacy
 * single-provider detail responses never reach this code, so their byte shape is
 * unchanged.
 */

import { z } from "zod";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { CompositeOutputsError } from "./composite-outputs.js";
import {
  type CompositeDeploymentRepositoryDeps,
  listCompositeTargets,
} from "./composite-repository.js";
import { DeploymentStatusSchema } from "./types.js";

/** Schema version of the composite detail block; bumped on breaking shape changes. */
export const COMPOSITE_DETAIL_VERSION = 1 as const;

/** Cloud providers a composite target may run on. */
export const COMPOSITE_TARGET_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;
export type CompositeTargetProvider = (typeof COMPOSITE_TARGET_PROVIDERS)[number];

/**
 * Response contract (the API spec source of truth in this repo, where Zod schemas
 * stand in for an OpenAPI document) for one composite target. Deliberately omits
 * every secret / identity field a target row carries (competitorRoleArn,
 * externalIdParameterName, teamLoginKey, awsAccountId, region, namePrefix, …).
 * Adding a field here is a conscious decision to widen the operator-visible
 * surface.
 */
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
});
export type CompositeTargetSummary = z.infer<typeof CompositeTargetSummarySchema>;

/** The optional `composite` block added to a composite parent's detail response. */
export const CompositeDetailSchema = z.object({
  version: z.literal(COMPOSITE_DETAIL_VERSION),
  targets: z.array(CompositeTargetSummarySchema).readonly(),
});
export type CompositeDetail = z.infer<typeof CompositeDetailSchema>;

/** True when a `stackOutputs` string is present but not parseable JSON. */
function isMalformedOutputJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/** Narrow a stored `runtimeProvider` to the whitelisted provider union. */
function normalizeProvider(raw: string): CompositeTargetProvider {
  return (COMPOSITE_TARGET_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as CompositeTargetProvider)
    : "aws";
}

/**
 * Build the composite detail block for a composite parent. Targets are returned
 * in GSI3 ordinal order. Throws {@link CompositeOutputsError} on a malformed
 * target output (no partial result) so the caller can return a controlled 500.
 *
 * The caller is responsible for tenant authorization + confirming the parent row
 * belongs to the requesting tenant; this module only projects already-authorized
 * target rows.
 */
export async function buildCompositeDetail(
  deps: CompositeDeploymentRepositoryDeps,
  parentDeploymentId: string,
): Promise<CompositeDetail> {
  const targets = await listCompositeTargets(deps, parentDeploymentId);

  const summaries: CompositeTargetSummary[] = targets.map((target) => {
    const raw = target.stackOutputs;
    if (raw && isMalformedOutputJson(raw)) {
      throw new CompositeOutputsError(parentDeploymentId, target.targetId, "malformed output JSON");
    }
    const outputs = parseStackOutputs(raw);

    const summary: CompositeTargetSummary = {
      targetId: target.targetId,
      targetDeploymentId: target.jobId,
      ordinal: target.targetOrdinal,
      provider: normalizeProvider(target.runtimeProvider),
      engine: target.runtimeEngine,
      status: target.status,
      updatedAt: target.updatedAt,
      ...(target.failureReason ? { failureReason: target.failureReason } : {}),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
    };
    return summary;
  });

  return { version: COMPOSITE_DETAIL_VERSION, targets: summaries };
}
