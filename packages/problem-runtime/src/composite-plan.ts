/**
 * [Composite Runtime / Issue #2062] Deterministic composite deployment planner.
 *
 * Pure function: given a validated {@link CompositeRuntimeDescriptor}, produce a
 * deterministic execution plan. NO external dependencies — no AWS SDK, no
 * `fetch`, no `process.env`, no `Date`, no randomness, no I/O. Equal inputs
 * always yield deeply-equal, deeply-frozen outputs.
 *
 * The plan is the provider-agnostic shape a later materialization step (#2063)
 * turns into parent + target deployment jobs. It deliberately carries ONLY the
 * per-target identity the metadata declares (id / ordinal / provider / engine /
 * entry) — no job ids, timestamps, account ids, regions, credentials, or retry
 * policy. Those are injected downstream where the side effects live.
 */

import {
  type CompositeRuntimeDescriptor,
  MAX_COMPOSITE_TARGETS,
  MIN_COMPOSITE_TARGETS,
  RuntimeValidationError,
} from "./index.js";

/** The four providers a composite target may target (ADR-026 / ADR-027). */
export const COMPOSITE_PROVIDERS = ["aws", "gcp", "azure", "sakura"] as const;
export type CompositeProvider = (typeof COMPOSITE_PROVIDERS)[number];

/** One planned target — declaration identity only, no execution detail. */
export interface CompositeDeploymentPlanTarget {
  readonly targetId: string;
  readonly targetOrdinal: number;
  readonly provider: CompositeProvider;
  readonly engine: string;
  readonly entry: string;
}

/** A deterministic plan derived from a composite runtime descriptor. */
export interface CompositeDeploymentPlan {
  readonly runtimeKind: "composite";
  readonly targets: readonly CompositeDeploymentPlanTarget[];
}

function isCompositeProvider(provider: string): provider is CompositeProvider {
  return (COMPOSITE_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Build a deterministic deployment plan from a composite runtime descriptor.
 *
 * Targets are emitted in declaration order (never sorted) with contiguous,
 * zero-based ordinals. The input is read-only; the output is deeply frozen.
 * Defensive re-validation (target count, unique ids, known provider) keeps a
 * malformed descriptor from producing a silently-wrong plan — violations throw
 * {@link RuntimeValidationError}.
 */
export function buildCompositeDeploymentPlan(
  runtime: CompositeRuntimeDescriptor,
): CompositeDeploymentPlan {
  const { targets } = runtime;
  const issues: { problemId: string; path: string; message: string }[] = [];
  if (targets.length < MIN_COMPOSITE_TARGETS || targets.length > MAX_COMPOSITE_TARGETS) {
    issues.push({
      problemId: "<unknown>",
      path: "runtime.targets",
      message: `composite runtime requires ${MIN_COMPOSITE_TARGETS}..${MAX_COMPOSITE_TARGETS} targets, got ${targets.length}`,
    });
  }

  const seen = new Set<string>();
  const planned: CompositeDeploymentPlanTarget[] = [];
  targets.forEach((target, index) => {
    const path = `runtime.targets[${index}]`;
    if (!isCompositeProvider(target.provider)) {
      issues.push({
        problemId: "<unknown>",
        path: `${path}.provider`,
        message: `unknown provider ${target.provider}`,
      });
      return;
    }
    if (seen.has(target.id)) {
      issues.push({
        problemId: "<unknown>",
        path: `${path}.id`,
        message: `duplicate target id ${target.id}`,
      });
      return;
    }
    seen.add(target.id);
    planned.push(
      Object.freeze({
        targetId: target.id,
        targetOrdinal: index,
        provider: target.provider,
        engine: target.engine,
        entry: target.entry,
      }),
    );
  });

  if (issues.length > 0) throw new RuntimeValidationError(issues);

  return Object.freeze({
    runtimeKind: "composite",
    targets: Object.freeze(planned),
  });
}
