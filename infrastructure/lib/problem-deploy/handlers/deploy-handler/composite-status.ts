/**
 * [Composite Runtime / Issue #2067] Pure deploy-phase status aggregation for a
 * composite parent.
 *
 * Given the statuses of a composite problem's target jobs, decide the single
 * status the parent coordination row should report **during the deploy phase**.
 * This module is deliberately:
 *   - pure & deterministic — no I/O, no clock, no DynamoDB, no adapters, and the
 *     result depends only on the multiset of target statuses (order-invariant);
 *   - deploy-phase only — teardown / deletion aggregation is a later issue, so a
 *     deletion-like target status is rejected, never guessed.
 *
 * The function inspects ONLY the status value — never provider, ordinal,
 * timestamps, outputs, or failure reasons.
 */

import type { DeploymentStatus } from "./types.js";

/**
 * Teardown / lifecycle-end statuses. Their presence during deploy aggregation
 * means the caller mixed phases; we reject rather than guess a parent state
 * (invariant 6).
 */
const DELETION_LIKE_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "DELETING",
  "DELETED",
  "EXPIRED",
  "AUTO_DELETED",
]);

/** Raised when target statuses cannot yield a valid deploy-phase parent status. */
export class CompositeStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeStatusError";
  }
}

/**
 * Aggregate composite target statuses into the parent's deploy-phase status.
 *
 * Precedence (order-independent over the input):
 *   1. empty input → throw (nothing to aggregate);
 *   2. any deletion-like status → throw (out of deploy phase);
 *   3. any FAILED → FAILED (FAILED wins over every deploy-phase state);
 *   4. every target PENDING → PENDING;
 *   5. every target COMPLETE → COMPLETE;
 *   6. otherwise → IN_PROGRESS (any mix, incl. APPROVAL_PENDING with no FAILED).
 */
export function aggregateCompositeDeployStatus(
  targetStatuses: readonly DeploymentStatus[],
): DeploymentStatus {
  if (targetStatuses.length === 0) {
    throw new CompositeStatusError("cannot aggregate an empty composite target status set");
  }

  const deletionLike = targetStatuses.find((status) => DELETION_LIKE_STATUSES.has(status));
  if (deletionLike) {
    throw new CompositeStatusError(
      `deletion-phase status ${deletionLike} is not valid during composite deploy aggregation`,
    );
  }

  if (targetStatuses.includes("FAILED")) return "FAILED";
  if (targetStatuses.every((status) => status === "PENDING")) return "PENDING";
  if (targetStatuses.every((status) => status === "COMPLETE")) return "COMPLETE";
  return "IN_PROGRESS";
}
