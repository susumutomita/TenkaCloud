/**
 * [Problem Test Harness / Issue #2107] Deterministic offline scorer.
 *
 * Given a problem's already-SDK-validated `scoring` metadata, the faked deploy
 * `outputs`, and the faked `probeResults`, classify the fixture as
 * `success` / `failure` / `not-runnable`. This is the *execution* the harness
 * asks for, NOT a second validator — validity is decided by the SDK
 * (`validateProblemMetadata`); this module only runs the scorer over an already
 * validated shape.
 *
 * Determinism: pure function of its inputs. No clock, ids, env, network, or cloud
 * SDKs. A probe is a lookup into the author-supplied `probeResults` map keyed by
 * the resolved output URL — never a real HTTP request.
 */

import type {
  CompositeProbeScoringMetadata,
  CompositeProbeTarget,
  FakeProbeResult,
  HarnessDiagnostic,
  MultiFlagScoringMetadata,
  ProblemScoringMetadata,
  ScoreOutcome,
  UptimeFlatScoringMetadata,
  UptimeMultiScoringMetadata,
} from "./scoring-types.js";

/** The diagnostic codes the scorer can raise. Stable contract. */
export const SCORING_DIAGNOSTIC_CODES = {
  /** A scoring rule references an output key the deploy outputs do not contain. */
  MISSING_OUTPUT_KEY: "SCORING_MISSING_OUTPUT_KEY",
  /** A composite-probe target references a targetId not declared by the runtime. */
  UNDECLARED_TARGET: "SCORING_UNDECLARED_TARGET",
  /** A probe of a declared output failed (non-expected status or unreachable). */
  PROBE_FAILED: "SCORING_PROBE_FAILED",
  /** The scoring section is present but is not one the harness can execute. */
  UNSUPPORTED_KIND: "SCORING_UNSUPPORTED_KIND",
} as const;

/** Default success statuses when a probe target declares none. */
const DEFAULT_OK_STATUSES: readonly number[] = [200];

export interface ScoreInput {
  readonly scoring: ProblemScoringMetadata;
  readonly outputs: Readonly<Record<string, string>>;
  readonly probeResults: Readonly<Record<string, FakeProbeResult>>;
  /** Composite runtime target ids, used to reject undeclared composite references. */
  readonly declaredTargetIds: readonly string[];
}

export interface ScoreResult {
  readonly outcome: ScoreOutcome;
  readonly diagnostics: readonly HarnessDiagnostic[];
}

/**
 * Run the scorer deterministically. A `not-runnable` outcome always carries at
 * least one diagnostic that explains the wiring error (missing output / undeclared
 * target / unsupported kind), so an author can distinguish it from a `failure`.
 */
export function runScorer(input: ScoreInput): ScoreResult {
  const { scoring } = input;
  switch (scoring.kind) {
    case "flag":
      return scoreFlag(scoring.flagOutputKey, input.outputs);
    case "multi-flag":
      return scoreMultiFlag(scoring, input.outputs);
    case "attack-detection":
      return scoreOutputKeyPresence(scoring.statsOutputKey, input.outputs);
    case "uptime-flat":
    case "uptime":
      return scoreUptimeFlat(scoring, input);
    case "uptime-multi":
      return scoreUptimeMulti(scoring, input);
    case "composite-probe":
      return scoreCompositeProbe(scoring, input);
    case "phased-polling":
      return scoreOutputKeyPresence(scoring.probe.metaPath, input.outputs);
    default:
      return unsupported(scoring);
  }
}

function unsupported(scoring: ProblemScoringMetadata): ScoreResult {
  return {
    outcome: "not-runnable",
    diagnostics: [
      {
        code: SCORING_DIAGNOSTIC_CODES.UNSUPPORTED_KIND,
        path: "metadata.json:scoring.kind",
        message: `scoring kind '${(scoring as { kind: string }).kind}' cannot be run by the local harness.`,
      },
    ],
  };
}

/** A `flag` problem scores when its declared output key is present and non-empty. */
function scoreFlag(flagOutputKey: string, outputs: Readonly<Record<string, string>>): ScoreResult {
  const missing = requireOutputKey(flagOutputKey, outputs, "scoring.flagOutputKey");
  if (missing) return missing;
  return { outcome: "success", diagnostics: [] };
}

/** A `multi-flag` problem scores when EVERY sub-flag output key is present. */
function scoreMultiFlag(
  scoring: MultiFlagScoringMetadata,
  outputs: Readonly<Record<string, string>>,
): ScoreResult {
  for (const flag of scoring.flags) {
    const missing = requireOutputKey(
      flag.flagOutputKey,
      outputs,
      `scoring.flags[${flag.id}].flagOutputKey`,
    );
    if (missing) return missing;
  }
  return { outcome: "success", diagnostics: [] };
}

/** Attack-detection / phased-polling score when their declared stat output is present. */
function scoreOutputKeyPresence(
  outputKey: string,
  outputs: Readonly<Record<string, string>>,
): ScoreResult {
  const missing = requireOutputKey(outputKey, outputs, "scoring.statsOutputKey");
  if (missing) return missing;
  return { outcome: "success", diagnostics: [] };
}

function scoreUptimeFlat(scoring: UptimeFlatScoringMetadata, input: ScoreInput): ScoreResult {
  const diagnostics: HarnessDiagnostic[] = [];
  let allOk = true;
  for (const [index, endpoint] of scoring.endpoints.entries()) {
    const outputKey = endpoint.outputKey ?? endpoint.slot;
    if (!outputKey) continue;
    const url = input.outputs[outputKey];
    if (url === undefined) {
      return missingOutput(outputKey, `scoring.endpoints[${index}].outputKey`);
    }
    if (!probeOk(input.probeResults[url], endpoint.expectStatus)) {
      allOk = false;
      diagnostics.push(probeFailedDiagnostic(url, `scoring.endpoints[${index}]`));
    }
  }
  return { outcome: allOk ? "success" : "failure", diagnostics };
}

function scoreUptimeMulti(scoring: UptimeMultiScoringMetadata, input: ScoreInput): ScoreResult {
  const diagnostics: HarnessDiagnostic[] = [];
  let allOk = true;
  for (const [index, slot] of scoring.probedSlots.entries()) {
    const url = input.outputs[slot.slot];
    if (url === undefined) {
      return missingOutput(slot.slot, `scoring.probedSlots[${index}].slot`);
    }
    if (!probeOk(input.probeResults[url], slot.expectStatus)) {
      allOk = false;
      diagnostics.push(probeFailedDiagnostic(url, `scoring.probedSlots[${index}]`));
    }
  }
  return { outcome: allOk ? "success" : "failure", diagnostics };
}

function scoreCompositeProbe(
  scoring: CompositeProbeScoringMetadata,
  input: ScoreInput,
): ScoreResult {
  const declared = new Set(input.declaredTargetIds);
  const diagnostics: HarnessDiagnostic[] = [];
  let allOk = true;
  for (const [index, target] of scoring.targets.entries()) {
    const undeclared = requireDeclaredTarget(target, declared, index);
    if (undeclared) return undeclared;
    const url = input.outputs[target.outputKey];
    if (url === undefined) {
      return missingOutput(target.outputKey, `scoring.targets[${index}].outputKey`);
    }
    if (!probeOk(input.probeResults[url], target.expectStatus)) {
      allOk = false;
      diagnostics.push(probeFailedDiagnostic(url, `scoring.targets[${index}]`));
    }
  }
  return { outcome: allOk ? "success" : "failure", diagnostics };
}

function requireDeclaredTarget(
  target: CompositeProbeTarget,
  declared: ReadonlySet<string>,
  index: number,
): ScoreResult | undefined {
  if (declared.has(target.targetId)) return undefined;
  return {
    outcome: "not-runnable",
    diagnostics: [
      {
        code: SCORING_DIAGNOSTIC_CODES.UNDECLARED_TARGET,
        path: `metadata.json:scoring.targets[${index}].targetId`,
        message: `composite scoring target '${target.targetId}' is not declared by the runtime targets.`,
      },
    ],
  };
}

function requireOutputKey(
  outputKey: string,
  outputs: Readonly<Record<string, string>>,
  path: string,
): ScoreResult | undefined {
  const value = outputs[outputKey];
  if (typeof value === "string" && value.length > 0) return undefined;
  return missingOutput(outputKey, path);
}

function missingOutput(outputKey: string, path: string): ScoreResult {
  return {
    outcome: "not-runnable",
    diagnostics: [
      {
        code: SCORING_DIAGNOSTIC_CODES.MISSING_OUTPUT_KEY,
        path: `metadata.json:${path}`,
        message: `scoring references output key '${outputKey}', which the deploy outputs do not contain.`,
      },
    ],
  };
}

function probeFailedDiagnostic(url: string, path: string): HarnessDiagnostic {
  return {
    code: SCORING_DIAGNOSTIC_CODES.PROBE_FAILED,
    path: `outputs:${path}`,
    message: `probe of '${url}' did not return an expected status (faked probe result).`,
  };
}

/**
 * A faked probe passes when the endpoint is reachable AND returns a status the
 * scoring rule expects (defaulting to 200). A `reachable: false` or an absent
 * probe result is a failure. Pure: a map lookup, never a real request.
 */
function probeOk(result: FakeProbeResult | undefined, expectStatus?: readonly number[]): boolean {
  if (!result) return false;
  if (result.reachable === false) return false;
  if (typeof result.status !== "number") return false;
  const expected = expectStatus && expectStatus.length > 0 ? expectStatus : DEFAULT_OK_STATUSES;
  return expected.includes(result.status);
}
