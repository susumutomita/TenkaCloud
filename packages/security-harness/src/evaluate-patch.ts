/**
 * Patch verdict rule (Issue #3036 採点契約): implements the 7-condition `verified-fixed` table and
 * the "does not destroy normal function" rejections as one pure, total function. Every branch
 * below cites the issue condition or non-goal it encodes, and every branch returns a `reasons`
 * entry so a verdict is always evidence-traceable rather than a bare label.
 *
 * Ordering matters and is deliberate: digest binding and baseline confirmation are checked before
 * anything else, because a verdict computed against the wrong artifact — or against an
 * unconfirmed baseline — is not evidence of anything, regardless of what the later stages say.
 * Forbidden side effects are checked before build/golden/witness results because a run that
 * violated its sandbox policy must never reach "verified-fixed" even if every functional signal
 * happens to look clean.
 */

import type { PatchEvaluation, PatchEvaluationInput, PatchVerdict } from "./types.js";

function withReason(
  reasons: string[],
  outcome: PatchVerdict,
  reason: string,
): { verdict: PatchVerdict; reasons: string[] } {
  reasons.push(reason);
  return { verdict: outcome, reasons };
}

export function evaluatePatchVerdict(input: PatchEvaluationInput): {
  verdict: PatchVerdict;
  reasons: string[];
} {
  const reasons: string[] = [];

  // Condition 7: target / patch / evidence digest must agree. A mismatch means later signals are
  // not known to be about the artifact being claimed, so this can never resolve to a verdict —
  // "inconclusive" per the issue's "stale patch digest を拒否する".
  if (!input.digestsMatch) {
    return withReason(
      reasons,
      "inconclusive",
      "target/patch/evidence digest mismatch — no verdict can be bound to an artifact",
    );
  }

  // Condition 1: the baseline vulnerability must have been independently confirmed. Evaluating a
  // patch against an unconfirmed baseline would score a fix for something never shown to exist.
  if (input.baselineFinding.verdict !== "confirmed") {
    return withReason(
      reasons,
      "inconclusive",
      `baseline finding verdict was "${input.baselineFinding.verdict}", not "confirmed" — nothing to certify a fix against`,
    );
  }

  // Condition 6: sandbox/policy violation. Checked before functional results so a violation can
  // never be outrun by an otherwise-clean run.
  if (input.forbiddenSideEffects.length > 0) {
    return withReason(
      reasons,
      "inconclusive",
      `forbidden side effects observed: ${input.forbiddenSideEffects.join(", ")}`,
    );
  }

  // Condition 2: patch build.
  if (input.build !== "passed") {
    return withReason(
      reasons,
      "inconclusive",
      "patch build failed — target startup failure never becomes a pass",
    );
  }

  // Condition 3 + "does not destroy normal function": golden behavior tests. A patch that removes
  // the endpoint, breaks auth, or otherwise regresses declared normal function fails here, and
  // this check runs before the witness checks below so a regression is never masked by a
  // technically-blocked exploit.
  if (input.goldenBehavior === "failed") {
    return withReason(
      reasons,
      "regressed",
      "golden behavior tests failed — the patch destroys declared normal function",
    );
  }
  if (input.goldenBehavior === "inconclusive") {
    return withReason(reasons, "inconclusive", "golden behavior tests were inconclusive");
  }

  // Condition 4: the original witness must no longer land.
  if (input.originalWitnessReplay === "landed") {
    return withReason(
      reasons,
      "still-vulnerable",
      "the original witness still lands on the patched target",
    );
  }
  if (input.originalWitnessReplay === "inconclusive") {
    return withReason(reasons, "inconclusive", "original witness replay was inconclusive");
  }

  // Condition 5: a fresh re-attack (different identity/object than the original witness) must not
  // find a new confirmed witness. This is what catches an incomplete patch that denylists only
  // the exact id the original witness used.
  if (input.freshReattack === "witness-confirmed") {
    return withReason(
      reasons,
      "still-vulnerable",
      "a fresh re-attack confirmed a new witness — the patch only blocked the original vector",
    );
  }
  if (input.freshReattack === "inconclusive") {
    return withReason(
      reasons,
      "inconclusive",
      "fresh re-attack was inconclusive — a fix cannot be certified without it",
    );
  }

  return withReason(
    reasons,
    "verified-fixed",
    "build passed, golden behavior held, the original witness is blocked, and a fresh re-attack found no witness within budget",
  );
}

/**
 * Convenience wrapper that returns the full `PatchEvaluation` record (input + computed
 * verdict/reasons/generatedAt) for reporting. `now` defaults to the real clock but is injectable
 * — same seam `phase1-slice.ts` and `evaluate-finding.ts`'s callers already use — so a caller that
 * needs deterministic timeline output (`./run-timeline.ts`) can fix it.
 */
export function evaluatePatch(
  input: PatchEvaluationInput,
  now: () => string = () => new Date().toISOString(),
): PatchEvaluation {
  const { verdict: v, reasons } = evaluatePatchVerdict(input);
  return { ...input, verdict: v, reasons, generatedAt: now() };
}
