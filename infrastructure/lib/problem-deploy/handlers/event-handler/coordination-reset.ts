import { isRoundTerminated } from "../generic-scoring-handler/round-liveness.js";
import { resolveCoordinationArtifactStore } from "../shared/coordination-artifact-store.js";
import { isCoordinationDeploymentPlayable } from "../shared/coordination-liveness.js";
import { startCoordinationRun } from "../shared/coordination-run.js";
import { logDeployTrace } from "../shared/trace-log.js";
import {
  type EventSharedResources,
  queryDeploymentsByEvent,
  resolveDeploymentsRepository,
  resolveEventsRepository,
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
 * written against. The dispatcher materializes the new run from `plugin.initialState`;
 * a durable pointer flag guarantees recovery even if the event ends before its next tick.
 *
 * That difference matters most in the case a reset is actually used for. An
 * operator resets because something went wrong; the old reset destroyed the
 * evidence of what went wrong as its first act. Runs beyond the retention
 * window are still removed — history is a debrief, not an archive.
 *
 * [Issue #3194] A saved score delivery must finish before the run can end.
 * Pending delivery returns the existing conflict outcome; the current run
 * stays reachable by normal op/tick recovery, then the operator can retry.
 * New reset requests are refused after end. A reset accepted before that
 * boundary still completes its saved initialization and initial-score delivery.
 */
export type CoordinationResetOutcome =
  | { readonly kind: "ok"; readonly result: CoordinationResetResult }
  /** The event has no deployment of this problem, so there is no match to reset. */
  | { readonly kind: "not_found" }
  /** Ended events cannot accept another reset. */
  | { readonly kind: "event_ended" }
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
  // Ordinary problems have no dispatcher that can complete an initialization.
  // Do not create a durable reset obligation for an undeclared coordination scope.
  if (!Object.hasOwn(shared.problemsCoordination ?? {}, problemId)) return { kind: "not_found" };
  const events = await resolveEventsRepository(shared);
  const event = await events.getEvent(tenantId, eventId);
  if (!event) return { kind: "not_found" };
  const nowIso = new Date().toISOString();
  if (
    ["ENDED", "TEARDOWN", "ARCHIVED"].includes(event.status) ||
    isRoundTerminated({ eventStartsAt: event.startsAt, eventEndsAt: event.endsAt }, nowIso)
  )
    return { kind: "event_ended" };
  const deployments = await queryDeploymentsByEvent(shared, tenantId, eventId);
  const repository = await resolveDeploymentsRepository(shared);
  let deployed = false;
  // GSI1 is discovery only: a just-retired deployment can still appear playable.
  // Re-read the candidate's authoritative META row before admitting this reset.
  for (const item of deployments) {
    if (item.problemId !== problemId || !item.jobId) continue;
    const current = await repository.getDeployment(item.jobId, { consistentRead: true });
    if (
      current?.tenantId === tenantId &&
      current.eventId === eventId &&
      current.problemId === problemId &&
      isCoordinationDeploymentPlayable(current)
    ) {
      deployed = true;
      break;
    }
  }
  if (!deployed) return { kind: "not_found" };

  const outcome = await startCoordinationRun(
    { repository, artifacts: resolveCoordinationArtifactStore() },
    { tenantId, eventId, problemId },
    nowIso,
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
