import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../control-data/domain/coordination-scope.js";
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
 * The coordination namespace is `tenant x event x problem x run`, and the
 * platform issues exactly one run id per `(event, problem)`
 * ({@link DEFAULT_COORDINATION_RUN_ID}). Re-deploying the same problem into the
 * same event therefore lands on the same persistence key, and the only
 * lifecycle that removed coordination state was event teardown — so the "new"
 * match resumed the previous one's `state`, `version`, ledger and scores.
 *
 * The obvious fix, resetting from the deploy path, is worse than the bug.
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
 *
 * So the reset is its own operator gesture, with the same shape as teardown's
 * cleanup: remove the row and let the next op re-materialize the namespace from
 * `plugin.initialState`. That is the whole reset — there is no second run id to
 * allocate, and no state to migrate.
 */
export type CoordinationResetOutcome =
  | { readonly kind: "ok"; readonly result: CoordinationResetResult }
  /** The event has no deployment of this problem, so there is no match to reset. */
  | { readonly kind: "not_found" };

export interface CoordinationResetResult {
  readonly eventId: string;
  readonly problemId: string;
  /** Echoed so an operator can see which namespace was cleared. */
  readonly runId: string;
}

/**
 * Clears the coordination state of one problem in one event.
 *
 * Guarded on the event actually having deployed the problem. Without that check
 * a typo in `problemId` would return a cheerful success for a namespace that
 * never existed, and the operator would believe they had reset the match they
 * meant to reset. The delete itself stays idempotent, so resetting twice — or
 * resetting a problem whose match never started — still succeeds.
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

  const scope: CoordinationStateScope = {
    tenantId,
    eventId,
    problemId,
    runId: DEFAULT_COORDINATION_RUN_ID,
  };
  const repository: DeploymentsCoordinationPort = await resolveDeploymentsRepository(shared);
  await repository.deleteCoordinationState(scope);
  logDeployTrace("coordination.run-reset", { tenantId, eventId, problemIds: problemId });
  return { kind: "ok", result: { eventId, problemId, runId: scope.runId } };
}
