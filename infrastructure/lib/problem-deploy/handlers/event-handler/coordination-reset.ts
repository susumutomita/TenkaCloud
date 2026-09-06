import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import { resolveCoordinationArtifactStore } from "../shared/coordination-artifact-store.js";
import { startCoordinationRun } from "../shared/coordination-run.js";
import { logDeployTrace } from "../shared/trace-log.js";
import {
  type EventSharedResources,
  queryDeploymentsByEvent,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * [Issue #3126] Starts a fresh coordination match for one `(event, problem)`.
 *
 * ## Why this is an explicit operation and not a hook on deploy
 *
 * `bulkDeployEvent` is documented for and used on events that are already
 * running: `{ teamIds }` adds a late-joining team, `{ retryFailedOnly: true }`
 * retries a team whose stack failed, and `{ forceRedeploy: true }` replaces one
 * team's terminal row. Each of those is a per-team operation against a live
 * event, and coordination state is shared by every team on the problem.
 * Clearing it there would wipe a match in progress for everyone because one
 * team joined late — a much larger failure than the one being fixed.
 *
 * Deleting a single deployment does not reset either, for the same reason, and
 * that is deliberate (see `DeploymentsCoordinationPort.deleteCoordinationState`).
 * Once the LAST deployment of a problem is gone there is nothing left to reset
 * and the state is removed outright (#3149).
 *
 * ## [Issue #3153] What a reset now does
 *
 * It starts a new run rather than deleting the namespace. The previous match's
 * state, ledger, scores and artifacts stay readable under the run id they were
 * written against, and the next operation materializes the new run from
 * `plugin.initialState` exactly as the delete-based reset did.
 *
 * That difference matters most in the case a reset is actually used for. An
 * operator resets because something went wrong; the old reset destroyed the
 * evidence of what went wrong as its first act. Runs beyond the retention
 * window are still removed — history is a debrief, not an archive.
 *
 * [Issue #3194] A saved score delivery must finish before the run can end.
 * Pending delivery returns the existing conflict outcome; the current run
 * stays reachable by normal op/tick recovery, then the operator can retry.
 */
export type CoordinationResetOutcome =
  | { readonly kind: "ok"; readonly result: CoordinationResetResult }
  /** The event has no deployment of this problem, so there is no match to reset. */
  | { readonly kind: "not_found" }
  /**
   * Another rotation started a run first, or saved score delivery is pending.
   * Reported rather than retried: the caller must re-read the current run and
   * allow its delivery recovery before deciding to reset again.
   */
  | { readonly kind: "conflict" };

export interface CoordinationResetResult {
  readonly eventId: string;
  readonly problemId: string;
  /** The run participants will play from now on. */
  readonly runId: string;
  /**
   * [Issue #3153] The run that just ended, still readable under its own scope
   * until the retention window pushes it out.
   */
  readonly previousRunId: string;
}

/**
 * Starts a new run of one problem in one event.
 *
 * Guarded on the event actually having deployed the problem. Without that check
 * a typo in `problemId` would return a cheerful success for a namespace that
 * never existed, and the operator would believe they had reset the match they
 * meant to reset.
 *
 * A lost rotation race is reported rather than retried. Two operators resetting
 * the same match at once should not end up with two runs started and one of
 * them silently discarded; the loser is told, and can look at which run is
 * current before deciding whether they still want another one.
 */
export async function resetCoordinationRun(
  shared: EventSharedResources,
  tenantId: string,
  eventId: string,
  problemId: string,
): Promise<CoordinationResetOutcome> {
  const deployments = await queryDeploymentsByEvent(shared, tenantId, eventId);
  const deployed = deployments.some((item) => item.problemId === problemId);
  if (!deployed) return { kind: "not_found" };

  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(shared);
  const outcome = await startCoordinationRun(
    { repository, artifacts: resolveCoordinationArtifactStore() },
    { tenantId, eventId, problemId },
    new Date().toISOString(),
  );
  if (outcome.kind === "conflict") return { kind: "conflict" };
  logDeployTrace("coordination.run-reset", {
    tenantId,
    eventId,
    problemIds: problemId,
    runId: outcome.runId,
    previousRunId: outcome.previousRunId,
  });
  return {
    kind: "ok",
    result: {
      eventId,
      problemId,
      runId: outcome.runId,
      previousRunId: outcome.previousRunId,
    },
  };
}
