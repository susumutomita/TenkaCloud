/**
 * Baseline/finding verdict rule (Issue #3036 "Baseline first" / "No false pass"):
 *
 *   - a digest mismatch (tampered witness, wrong target) is an explicit REJECT, never a silent
 *     pass-through;
 *   - a sandbox failure, a non-fresh environment, or zero attempts can never produce "confirmed" —
 *     they fall back to "inconclusive", not to success;
 *   - zero successful reproductions out of at least one real attempt means the claimed
 *     vulnerability could not be reproduced at all, so the finding is REJECTED (not merely
 *     "unknown" — the verifier positively could not observe it);
 *   - a partial reproduction below `minimumReproductions` is flaky evidence: "inconclusive", not
 *     "confirmed" — the issue explicitly forbids treating a flaky witness as confirmed;
 *   - only meeting or exceeding `minimumReproductions` in a fresh environment, with matching
 *     digests, yields "confirmed".
 *
 * This function is pure and total: every branch returns a `FindingVerdict`, none of them throws,
 * and none of them depends on anything but its argument.
 */

import type { FindingVerdict } from "./types.js";

export interface EvaluateFindingInput {
  /** True only when the finding's recorded `targetDigest` matches what was actually built/launched. */
  readonly targetDigestMatches: boolean;
  /** True only when the finding's recorded `threatModelDigest` matches the run's declared threat model. */
  readonly threatModelDigestMatches: boolean;
  readonly attempts: number;
  readonly successes: number;
  readonly minimumReproductions: number;
  /** False if the verifier reused a Finder's (or any prior) workspace instead of a clean one. */
  readonly freshEnvironment: boolean;
  /** True if the verifier's own sandbox/process crashed, timed out, or errored before producing a real result. */
  readonly sandboxFailure: boolean;
}

export function evaluateFindingVerdict(input: EvaluateFindingInput): FindingVerdict {
  if (!input.targetDigestMatches || !input.threatModelDigestMatches) {
    return "rejected";
  }
  if (input.sandboxFailure || !input.freshEnvironment || input.attempts <= 0) {
    return "inconclusive";
  }
  if (input.successes >= input.minimumReproductions) {
    return "confirmed";
  }
  if (input.successes === 0) {
    return "rejected";
  }
  return "inconclusive";
}
