/**
 * [Composite Runtime / Issue #2070] `composite-probe` scoring kind.
 *
 * Opt-in scorer for Composite problems. It is a **pure** function over a
 * Composite-shaped input (the parent + its per-target runtime view) plus an
 * injected probe, so it is fully unit-testable with a fake probe — no real
 * network, no DynamoDB, no cloud SDK.
 *
 * Behavior (Issue #2070):
 *   1. Runs ONLY when the composite parent status is COMPLETE.
 *   2. Every metadata scoring target must exist in the runtime target view; an
 *      absent target is a non-success result naming the missing targetId.
 *   3. Every metadata scoring target must itself be COMPLETE.
 *   4. The existing HTTPS probe machinery runs once per declared scoring target.
 *   5. The composite is success ONLY when EVERY declared probe succeeds
 *      (`success: "all"` — the only supported rule).
 *   6. A missing / not-ready target, a malformed output (missing the explicitly
 *      named output key), or a failed probe yields a non-success result whose
 *      diagnostic `data` names the offending targetId.
 *   7. The scorer never infers a URL field name — it reads exactly the
 *      `outputKey` the metadata target declares.
 *
 * This module adds NO provider-specific probing SDK: every provider (aws / gcp /
 * azure / sakura) is probed through the same single HTTPS probe, reusing the
 * generic scoring Lambda's existing probe contract.
 */

import type {
  CompositeProbeScoringMetadata,
  CompositeProbeTarget,
} from "../../../../utils/scoring-metadata.js";
import type { DeploymentStatus } from "../../deploy-handler/types.js";
import { joinUrl } from "../shared.js";

/** The four runtimes a composite target may resolve to. */
export type CompositeTargetProvider = "aws" | "gcp" | "azure" | "sakura";

/** One runtime target of a composite parent, as scored. */
export interface CompositeProbeRuntimeTarget {
  readonly targetId: string;
  readonly provider: CompositeTargetProvider;
  readonly status: DeploymentStatus;
  /** The target's namespaced runtime outputs (#2069 view), keyed by output name. */
  readonly outputs: Readonly<Record<string, string>>;
}

/** The Composite scoring input contract (Issue #2070). */
export interface CompositeProbeInput {
  readonly parentDeploymentId: string;
  /** The composite parent's aggregated deploy status. */
  readonly parentStatus: DeploymentStatus;
  readonly targets: readonly CompositeProbeRuntimeTarget[];
}

/** The probe injected into the scorer. Returns whether the target URL is healthy. */
export type CompositeProbeFn = (
  url: string,
  options: { readonly expectStatus?: readonly number[] },
) => Promise<{ readonly ok: boolean }>;

/** Why a single declared target did not pass (diagnostic, names the targetId). */
export type CompositeTargetFailureReason =
  | "target-absent"
  | "target-not-complete"
  | "output-missing"
  | "probe-failed";

export interface CompositeTargetDiagnostic {
  readonly targetId: string;
  readonly reason: CompositeTargetFailureReason;
}

/**
 * The scorer result. `success` is true ONLY when every declared probe succeeded.
 * `pointsAwarded` is `pointsAllOk` on success and 0 otherwise. `notReady` flags
 * the "parent not COMPLETE yet" case (= do not score, do not penalize). `data`
 * carries per-target diagnostics for any target that did not pass.
 */
export interface CompositeProbeScoreResult {
  readonly success: boolean;
  readonly notReady: boolean;
  readonly pointsAwarded: number;
  readonly probedTargetIds: readonly string[];
  readonly data: { readonly failures: readonly CompositeTargetDiagnostic[] };
}

function notReadyResult(): CompositeProbeScoreResult {
  return {
    success: false,
    notReady: true,
    pointsAwarded: 0,
    probedTargetIds: [],
    data: { failures: [] },
  };
}

/**
 * Score a composite problem from its parent + per-target runtime view.
 *
 * Pure: all side effects (the network probe) are injected via `probe`. Runs one
 * probe per declared scoring target, and only when every target is present,
 * COMPLETE, exposes its declared output key, and passes its probe does it award
 * `pointsAllOk`.
 */
export async function scoreCompositeProbe(
  input: CompositeProbeInput,
  scoring: CompositeProbeScoringMetadata,
  probe: CompositeProbeFn,
): Promise<CompositeProbeScoreResult> {
  // (1) Only score once the parent has finished deploying.
  if (input.parentStatus !== "COMPLETE") return notReadyResult();

  const targetsById = new Map(input.targets.map((t) => [t.targetId, t] as const));

  // Resolve each declared scoring target into a probe URL (or a diagnostic).
  // Targets that fail resolution are non-success but still recorded so the
  // failing targetId surfaces. We keep declaration order stable.
  const resolutions = scoring.targets.map((declared) =>
    resolveTarget(declared, targetsById.get(declared.targetId)),
  );

  // (4) Run the existing probe machinery once per declared scoring target that
  // resolved to a URL. Resolution failures contribute their diagnostic directly.
  const probedTargetIds = scoring.targets.map((t) => t.targetId);
  const failures: CompositeTargetDiagnostic[] = [];

  const probeOutcomes = await Promise.all(
    resolutions.map(async (resolution) => {
      if (resolution.kind === "diagnostic") return resolution.diagnostic;
      const result = await probe(resolution.url, {
        ...(resolution.declared.expectStatus
          ? { expectStatus: resolution.declared.expectStatus }
          : {}),
      });
      return result.ok
        ? undefined
        : ({ targetId: resolution.declared.targetId, reason: "probe-failed" } as const);
    }),
  );
  for (const outcome of probeOutcomes) {
    if (outcome) failures.push(outcome);
  }

  // (5) Success only when EVERY declared probe succeeded.
  const success = failures.length === 0;
  return {
    success,
    notReady: false,
    pointsAwarded: success ? scoring.pointsAllOk : 0,
    probedTargetIds,
    data: { failures },
  };
}

type TargetResolution =
  | { readonly kind: "url"; readonly url: string; readonly declared: CompositeProbeTarget }
  | { readonly kind: "diagnostic"; readonly diagnostic: CompositeTargetDiagnostic };

/**
 * Resolve a declared scoring target into a probe URL, or a typed diagnostic when
 * the runtime target is absent (2), not COMPLETE (3), or missing the explicitly
 * named output key (6/7). Never infers a URL field name.
 */
function resolveTarget(
  declared: CompositeProbeTarget,
  runtime: CompositeProbeRuntimeTarget | undefined,
): TargetResolution {
  if (!runtime) {
    return {
      kind: "diagnostic",
      diagnostic: { targetId: declared.targetId, reason: "target-absent" },
    };
  }
  if (runtime.status !== "COMPLETE") {
    return {
      kind: "diagnostic",
      diagnostic: { targetId: declared.targetId, reason: "target-not-complete" },
    };
  }
  const baseUrl = runtime.outputs[declared.outputKey];
  if (!baseUrl) {
    return {
      kind: "diagnostic",
      diagnostic: { targetId: declared.targetId, reason: "output-missing" },
    };
  }
  const url = declared.path ? joinUrl(baseUrl, declared.path) : baseUrl;
  return { kind: "url", url, declared };
}
