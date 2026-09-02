import type { CoordinationArtifactStore } from "../../control-data/coordination-artifact-store.js";
import type { DeploymentsCoordinationPort } from "../../control-data/deployments-repository.js";
import {
  COORDINATION_RUN_HISTORY_LIMIT,
  type CoordinationRunKey,
  type CoordinationRunPointer,
  coordinationScopeForRun,
  createCoordinationRunId,
  initialCoordinationRunPointer,
  rotateCoordinationRunPointer,
} from "../../control-data/domain/coordination-run.js";
import { logDeployTrace } from "./trace-log.js";

/**
 * The run pointer carries no TTL, and that asymmetry with the state rows it
 * names is deliberate.
 *
 * The two failure directions are not symmetric. A pointer that outlives its
 * runs is a few dozen bytes naming a run whose state has expired — and the next
 * operation simply materializes that run from `plugin.initialState`, which is
 * correct. A pointer that expires FIRST resolves every participant back to the
 * initial run, which is a different match: they would read, and then write,
 * whatever state happens to be sitting there.
 *
 * A TTL cannot be made safe by being longer, only by being refreshed, and
 * refreshing on read means a write on every request. So the pointer's lifecycle
 * is explicit instead: event teardown and the last-deployment cleanup (#3149)
 * both delete it, and the number of pointers is bounded by the number of
 * `(event, problem)` pairs ever deployed rather than growing with play.
 *
 * Zero is the "never expires" value both backends already understand — the
 * sweep skips rows whose `expiresAt` is not positive.
 */
const COORDINATION_RUN_POINTER_NEVER_EXPIRES = 0;

/**
 * [Issue #3153] Resolving and rotating a problem's current run.
 *
 * Every path that touches coordination state goes through
 * {@link resolveCurrentCoordinationRunId} instead of naming a run id, so there
 * is one answer to "which match is being played" and the participant path, the
 * tick and the teardown cannot disagree about it. A disagreement here is not a
 * stale read: it is two halves of the platform operating on two different
 * matches.
 */

export interface CoordinationRunDeps {
  readonly repository: DeploymentsCoordinationPort;
  /**
   * Removed alongside a retired run's state. Optional so a deployment with no
   * artifact bucket keeps working.
   */
  readonly artifacts?: CoordinationArtifactStore;
}

/**
 * The run this `(tenant, event, problem)` is on right now.
 *
 * An absent pointer resolves to the initial run rather than minting one. That
 * is the whole backward-compatibility story: every match in flight when this
 * ships lives under the old constant, and minting on first read would move all
 * of them to an empty namespace and silently restart them from
 * `plugin.initialState`.
 *
 * A read failure is NOT swallowed. Falling back to the initial run on error
 * would send a participant's operation into whichever match happens to live
 * there — the previous one, if this problem has been reset — and the write
 * would succeed. An error that stops one request is recoverable; a write into
 * the wrong match is not.
 */
export async function resolveCurrentCoordinationRunId(
  repository: DeploymentsCoordinationPort,
  key: CoordinationRunKey,
): Promise<string> {
  const pointer = await repository.readCoordinationRun(key);
  return pointer?.runId ?? initialCoordinationRunPointer("").runId;
}

export type StartCoordinationRunOutcome =
  | {
      readonly kind: "started";
      readonly runId: string;
      readonly previousRunId: string;
      /** Runs pushed out of the retention window, whose data has been removed. */
      readonly retired: readonly string[];
    }
  /**
   * Another rotation won. The caller re-reads to see which run is current
   * rather than assuming its own.
   */
  | { readonly kind: "conflict" };

/**
 * Starts a fresh run of one problem, keeping the previous one readable.
 *
 * ## Order of operations, and why
 *
 *   1. read the current pointer
 *   2. compute the next pointer and what the retention window pushes out
 *   3. write the pointer, conditional on the run it replaces
 *   4. only then delete the runs that fell out of the window
 *
 * Step 4 comes last because a rotation that loses its race must delete nothing.
 * Deleting first would mean two operators resetting at once destroy history the
 * winner is still keeping, and the loser would have done it while being told it
 * did not start a run at all.
 *
 * The new run's namespace is not created here. It does not need to be: an
 * absent state row IS an uninitialized match, and the first operation
 * materializes it from `plugin.initialState` exactly as the old delete-based
 * reset did. What has changed is that the previous match's state and artifacts
 * are still there afterwards, under a namespace nothing writes to any more.
 */
export async function startCoordinationRun(
  deps: CoordinationRunDeps,
  key: CoordinationRunKey,
  nowIso: string,
  newRunId: string = createCoordinationRunId(),
): Promise<StartCoordinationRunOutcome> {
  const current: CoordinationRunPointer =
    (await deps.repository.readCoordinationRun(key)) ?? initialCoordinationRunPointer(nowIso);
  const rotation = rotateCoordinationRunPointer(
    current,
    newRunId,
    nowIso,
    COORDINATION_RUN_HISTORY_LIMIT,
  );
  const written = await deps.repository.rotateCoordinationRun(
    key,
    current.runId,
    rotation.pointer,
    COORDINATION_RUN_POINTER_NEVER_EXPIRES,
  );
  if (written.outcome !== "updated") return { kind: "conflict" };

  await retireCoordinationRuns(deps, key, rotation.retired);
  logDeployTrace("coordination.run-started", {
    tenantId: key.tenantId,
    eventId: key.eventId,
    problemIds: key.problemId,
    runId: rotation.pointer.runId,
    previousRunId: current.runId,
    retired: rotation.retired.length,
  });
  return {
    kind: "started",
    runId: rotation.pointer.runId,
    previousRunId: current.runId,
    retired: rotation.retired,
  };
}

/**
 * Deletes the state and artifacts of runs that have left the retention window.
 *
 * Best-effort per run and never fatal: the pointer is already written, so the
 * runs being removed are unreachable through any normal path, and failing the
 * caller here would report that a reset did not happen when it did. Both the
 * state row's TTL and the artifact bucket's expiry still reap what is left.
 */
async function retireCoordinationRuns(
  deps: CoordinationRunDeps,
  key: CoordinationRunKey,
  retired: readonly string[],
): Promise<void> {
  const outcomes = await Promise.allSettled(
    retired.map(async (runId) => {
      const scope = coordinationScopeForRun(key, runId);
      await deps.repository.deleteCoordinationState(scope);
      await deps.artifacts?.deleteScope(scope);
    }),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "fulfilled") continue;
    logDeployTrace("coordination.run-retire-failed", {
      tenantId: key.tenantId,
      eventId: key.eventId,
      problemIds: key.problemId,
      runId: retired[index],
      reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
  }
}

/**
 * Removes every run of a problem — current, history, and the pointer itself.
 *
 * For when the problem goes rather than the match: event teardown, or the last
 * deployment being torn down. The pointer is deleted LAST so a failure part way
 * through leaves a pointer naming runs that still exist, rather than orphaned
 * runs nothing names. Retrying then converges; the other order would strand
 * data no path could reach.
 */
export async function deleteAllCoordinationRuns(
  deps: CoordinationRunDeps,
  key: CoordinationRunKey,
): Promise<readonly string[]> {
  const pointer = await deps.repository.readCoordinationRun(key);
  const runs = pointer
    ? [pointer.runId, ...pointer.history]
    : [initialCoordinationRunPointer("").runId];
  for (const runId of runs) {
    const scope = coordinationScopeForRun(key, runId);
    await deps.repository.deleteCoordinationState(scope);
    await deps.artifacts?.deleteScope(scope);
  }
  await deps.repository.deleteCoordinationRun(key);
  return runs;
}
