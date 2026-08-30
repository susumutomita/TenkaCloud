/**
 * [Issue #3123] The platform-owned namespace for one coordination state row.
 *
 * Coordination state used to be keyed by `(tenantId, eventId)` alone. That is
 * not unique: an event can deploy more than one coordination problem, and the
 * same problem can be run more than once inside one event. Every such pair
 * shared a single row, so two problems in one event silently overwrote each
 * other's game state (last writer won, and the loser's `version` bump made the
 * next honest write look like a conflict).
 *
 * This type is the fix: the key carries `problem` and `run` as first-class
 * dimensions, and every port method takes the whole scope as ONE required
 * argument. That shape is deliberate:
 *
 *   - Required, not optional. An earlier draft of this change gave `problemId`
 *     and `runId` `"legacy"` defaults so existing call sites kept compiling.
 *     That reintroduces the bug it fixes — any call site that forgets an
 *     argument silently rejoins the shared namespace instead of failing to
 *     compile.
 *   - One object, not four positional strings. `(tenantId, eventId, problemId,
 *     runId)` are four same-typed parameters; a transposition typechecks and
 *     lands on a valid-looking but wrong partition.
 *
 * Plugins never see this type. It is persistence-key material, owned entirely
 * by the platform, exactly as the Issue #3123 responsibility split requires:
 * the problem plugin owns `initialState` / `validateOp` / `applyOp` / `tick` /
 * `projectForTeam` and nothing about where the bytes live.
 */
export interface CoordinationStateScope {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly runId: string;
}

/**
 * The run identifier the platform issues today.
 *
 * The platform currently models exactly one coordination run per
 * `(event, problem)`: there is no API that starts a second, concurrent run of
 * the same problem inside one event. Rather than pretend otherwise by aliasing
 * `runId` to `problemId` (which would make the two dimensions indistinguishable
 * and collapse the moment a real run id ever equalled a problem id), the
 * resolver issues this constant and the key keeps a genuine, separate run
 * dimension for when that API arrives.
 *
 * Restarting a run needs no new id: {@link CoordinationStateScope} deletion is
 * the reset. Removing the row returns the namespace to "uninitialized", and the
 * next op re-materializes it from `plugin.initialState(ctx)`.
 */
export const DEFAULT_COORDINATION_RUN_ID = "default";

/**
 * Reserved namespace holding rows written before this change, migrated in place
 * by the SQL backend so they are preserved for forensics but can never be read
 * back as live state.
 *
 * Unreachable by construction: a real `problemId` must match
 * `PROBLEM_ID_RE` (`handlers/shared/constants.ts`), which allows only
 * `[a-z0-9-]`, so no resolvable scope can ever spell an underscore. See
 * `sql-deployments-core.ts` for the migration and this repository's PR notes
 * for the compatibility policy (pre-#3123 state does not carry over; a match
 * in flight across the deploy re-initializes).
 */
export const PRE_SCOPE_COORDINATION_NAMESPACE = "__pre_scope__";

/**
 * How long a coordination row survives its last write.
 *
 * This is the backstop for a cleanup that never ran (a teardown that failed
 * mid-way, an event row deleted out from under its deployments), not the
 * primary delete path — {@link CoordinationStateScope} deletion on event
 * teardown is. Every successful write pushes the deadline out, so the clock
 * only starts once a match stops being played.
 *
 * Seven days matches the deployments table's own post-terminal audit retention
 * (`handlers/shared/deployment-retention.ts`), so a debrief or replay that can
 * still read the deployment rows can still read the coordination state they
 * refer to.
 */
const COORDINATION_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The TTL value (epoch seconds) to stamp on a row written at `nowMs`. */
export function coordinationStateExpiresAt(nowMs: number): number {
  return Math.floor((nowMs + COORDINATION_STATE_RETENTION_MS) / 1000);
}
