/**
 * `SecurityRun` state machine (Issue #3036 Phase 0 contract, "each transition is idempotent and
 * resumable"). Pure and synchronous: given a current state and a requested next state, it either
 * returns the next state or throws `IllegalSecurityRunTransitionError`. It never reads the clock,
 * never retries, and never invokes any of the actually-risky work (build/verify/patch) itself —
 * that belongs to the orchestrator in ./phase1-slice.ts, which must call `transitionSecurityRun`
 * BEFORE running a stage so that a run already in a terminal state can never start new work
 * ("cancellation 後に新規 command が実行されない").
 *
 * Phase 1 does not run an autonomous Finder, so its slice moves BUILDING -> VERIFYING directly
 * (skipping RECONNING / FINDING) and DEDUPING -> READY_FOR_REMEDIATION with exactly one finding.
 * Both edges are declared here now so Phase 2's Recon/Find loop is additive, not a reshape of
 * this file.
 */

import type { SecurityRunState } from "./types.js";

export const TERMINAL_STATES: ReadonlySet<SecurityRunState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INCONCLUSIVE",
]);

export function isTerminalState(state: SecurityRunState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Directed edges: from each key, the states a run may move to next. Every non-terminal state can
 * reach CANCELLED and FAILED — a run may always be killed or fail, and no rule below needs to
 * repeat that fact.
 */
const KILLABLE: readonly SecurityRunState[] = ["CANCELLED", "FAILED"];

const TRANSITIONS: Readonly<Record<SecurityRunState, readonly SecurityRunState[]>> = {
  QUEUED: ["BUILDING", ...KILLABLE],
  // BUILDING -> VERIFYING: Phase 1's no-Finder fast path. BUILDING -> RECONNING: Phase 2+.
  BUILDING: ["RECONNING", "VERIFYING", "INCONCLUSIVE", ...KILLABLE],
  RECONNING: ["FINDING", "INCONCLUSIVE", ...KILLABLE],
  FINDING: ["VERIFYING", "INCONCLUSIVE", ...KILLABLE],
  VERIFYING: ["DEDUPING", "INCONCLUSIVE", ...KILLABLE],
  DEDUPING: ["READY_FOR_REMEDIATION", "INCONCLUSIVE", ...KILLABLE],
  // No INCONCLUSIVE beyond this point: a confirmed baseline is already established, so patch
  // review either produces a verdict or is killed — it does not quietly downgrade to "unknown".
  READY_FOR_REMEDIATION: ["VALIDATING_PATCH", "CANCELLED"],
  VALIDATING_PATCH: ["REATTACKING", "FAILED", "CANCELLED"],
  REATTACKING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INCONCLUSIVE: [],
};

export class IllegalSecurityRunTransitionError extends Error {
  constructor(
    readonly from: SecurityRunState,
    readonly to: SecurityRunState,
  ) {
    super(`illegal SecurityRun transition "${from}" -> "${to}"`);
    this.name = "IllegalSecurityRunTransitionError";
  }
}

/** Whether `to` is reachable from `from` in one step. Requesting the same state is always legal (idempotent replay). */
export function canTransition(from: SecurityRunState, to: SecurityRunState): boolean {
  if (from === to) return true;
  if (isTerminalState(from)) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * Applies one transition. Replaying the current state (`next === current`) is a no-op success —
 * this is what makes resuming a run after a restart safe: re-issuing the last known transition
 * never throws. Any other move out of a terminal state, or any move `TRANSITIONS` does not list,
 * throws instead of silently clamping to some default state.
 */
export function transitionSecurityRun(
  current: SecurityRunState,
  next: SecurityRunState,
): SecurityRunState {
  if (!canTransition(current, next)) {
    throw new IllegalSecurityRunTransitionError(current, next);
  }
  return next;
}
