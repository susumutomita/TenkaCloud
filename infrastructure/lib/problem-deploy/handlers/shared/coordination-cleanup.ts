import type {
  DeploymentsCoordinationPort,
  DeploymentsQueryPort,
} from "../../control-data/deployments-repository.js";
import {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../control-data/domain/coordination-scope.js";
import type { DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES } from "./constants.js";
import { logDeployTrace } from "./trace-log.js";

/**
 * [Issue #3149] Removing a problem's coordination state once its last
 * deployment is gone.
 *
 * ## The gap this closes
 *
 * Coordination state is scoped to `tenant x event x problem x run`, and exactly
 * two things deleted it: event teardown (`bulk-delete.ts`, which clears every
 * problem in the event) and the operator's explicit run reset. Tearing down
 * deployments one at a time — the normal way to retire a single problem while
 * the event keeps running — deleted nothing, so the state stayed until its TTL
 * expired, which is seven days after the event stops being ticked.
 *
 * Not deleting on a SINGLE deployment's teardown is deliberate and stays that
 * way: coordination state is shared by every team on the problem, so removing
 * it because one team was torn down would wipe a match in progress for
 * everyone. The missing piece was only ever the last one.
 *
 * ## Why "the last one" is counted the way it is
 *
 * A deployment row is not removed when it is torn down; it is retained for
 * seven days of audit and it can land in `FAILED` rather than a deleted-like
 * status if the delete itself fails (#3128). Counting by status alone would
 * therefore both miss rows that are gone and keep rows that are not.
 *
 * The question this module actually asks is narrower and answerable: is there
 * any deployment of this problem that could still submit a coordination
 * operation? That is the same predicate the participant path applies
 * (`coordination-handler.ts`'s `canSubmitCoordination`), and it is anchored on
 * `teardownRequestedAt` — a permanent marker written once when a row first
 * enters `DELETING` — precisely because status is recoverable and this is not.
 * When no row can act, nothing can read or write the state, and it is garbage.
 */

/** The subset of a deployment row this decision reads. */
export interface CoordinationCleanupCandidate {
  readonly problemId?: string;
  readonly eventId?: string;
  readonly tenantId?: string;
  readonly status?: string;
  readonly teardownRequestedAt?: string;
}

export type CoordinationCleanupOutcome =
  /** The state row was removed. */
  | { readonly kind: "deleted"; readonly scope: CoordinationStateScope }
  /** At least one deployment of this problem can still act. */
  | { readonly kind: "retained"; readonly liveDeployments: number }
  /** There was no state row to remove (the match never started, or is already gone). */
  | { readonly kind: "absent" }
  /**
   * The state moved between the decision and the delete, so the delete was
   * refused. Something is playing this match again; leaving the row is correct.
   */
  | { readonly kind: "raced" }
  /** The row is not scoped to an event/problem, so it has no coordination namespace. */
  | { readonly kind: "not_applicable" };

export interface CoordinationCleanupDeps {
  readonly repository: DeploymentsQueryPort & DeploymentsCoordinationPort;
}

/**
 * Whether this deployment row could still submit a coordination operation.
 *
 * Mirrors `coordination-handler.ts`'s `canSubmitCoordination` exactly, and for
 * the same reason: if the two ever disagree, one of them is wrong about whether
 * a match is alive. The direction of the disagreement decides which failure you
 * get — cleanup deleting a playable match, or a match nobody can play keeping
 * its row forever.
 */
function canStillAct(item: CoordinationCleanupCandidate): boolean {
  if (item.teardownRequestedAt) return false;
  const status = (item.status ?? "PENDING") as DeploymentStatus;
  return !DELETED_LIKE_STATUSES.has(status);
}

/**
 * Deletes this problem's coordination state if the deployment just torn down
 * was the last one that could act on it.
 *
 * ## The race, and why the version is read first
 *
 * The order below is load-bearing:
 *
 *   1. read the state (and its `version`)
 *   2. count the deployments that can still act
 *   3. delete, conditional on that same `version`
 *
 * Reading the version BEFORE the count is what makes the condition meaningful.
 * A new deployment arriving after step 2 can only endanger a live match by
 * being played, and being played moves the version, so step 3 is refused. A new
 * deployment that has not been played is not a match in progress: its first
 * operation re-materializes the namespace from `plugin.initialState`, exactly
 * as it would have done had it arrived a moment later.
 *
 * Reading the version after the count would leave a window where a whole
 * match — write included — happens between the two reads and is then deleted at
 * its own current version, with the delete reporting success.
 *
 * ## What this must never do
 *
 * Cleanup must not change any identifier that has already been issued. It
 * deletes one scope's row or nothing at all: it never renumbers, never
 * rewrites, and never touches another problem's or another run's namespace.
 * The concrete harm is recorded in this issue: a plugin that derived an
 * order's sequence number from the length of a retained list had its counter
 * roll back when cleanup shortened that list, re-issued ids that were already
 * live, and rejected in-flight work as already complete.
 */
export async function cleanupCoordinationStateIfLastDeployment(
  deps: CoordinationCleanupDeps,
  item: CoordinationCleanupCandidate,
): Promise<CoordinationCleanupOutcome> {
  const { tenantId, eventId, problemId } = item;
  // A deployment created through the pre-event `POST /problems/:id/deploy` path
  // carries no event, so it has no coordination namespace to clean. Inventing a
  // scope for it would address rows that do not exist.
  if (!tenantId || !eventId || !problemId) return { kind: "not_applicable" };

  const scope: CoordinationStateScope = {
    tenantId,
    eventId,
    problemId,
    runId: DEFAULT_COORDINATION_RUN_ID,
  };

  const existing = await deps.repository.readCoordinationState(scope);
  // Nothing to reclaim. The match never started, or event teardown / a reset
  // already removed it. Deliberately NOT falling through to an unconditional
  // delete of the leftover match secret: that row carries its own TTL, and
  // deleting it here would race a match that is starting right now — the
  // secret would vanish from under shares already derived from it.
  if (!existing) return { kind: "absent" };

  const deployments = await deps.repository.listByTenantAndEvent(tenantId, eventId);
  const live = deployments.filter(
    (row) => row.problemId === problemId && canStillAct(row as CoordinationCleanupCandidate),
  );
  if (live.length > 0) return { kind: "retained", liveDeployments: live.length };

  const outcome = await deps.repository.deleteCoordinationStateIfUnchanged(scope, existing.version);
  if (outcome.outcome !== "updated") {
    logDeployTrace("coordination.cleanup.raced", {
      tenantId,
      eventId,
      problemIds: problemId,
      expectedVersion: existing.version,
    });
    return { kind: "raced" };
  }
  logDeployTrace("coordination.cleanup.deleted", {
    tenantId,
    eventId,
    problemIds: problemId,
    runId: scope.runId,
    version: existing.version,
  });
  return { kind: "deleted", scope };
}
