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
 * How long a coordination row survives once its event stops being ticked.
 *
 * This is the backstop for a cleanup that never ran (a teardown that failed
 * mid-way, an event row deleted out from under its deployments), not the
 * primary delete path — {@link CoordinationStateScope} deletion on event
 * teardown is.
 *
 * The clock is deliberately anchored to the EVENT going quiet, not to the
 * participants going quiet. Both a successful write and a per-minute tick
 * refresh the deadline (see the port's `touchCoordinationState`), and the tick
 * runs for every coordination problem in a started event regardless of whether
 * its plugin implements `tick`. Anchoring it to writes alone would have been
 * wrong in a way that loses data: a plugin with no `tick` hook —
 * `microservice-migration-battle`'s `router.ts` is one — writes only when a
 * participant acts, so in an open-ended event its registration state would age
 * out mid-match and the next request would silently rebuild from
 * `plugin.initialState`.
 *
 * Seven days then matches the deployments table's own post-terminal audit
 * retention (`handlers/shared/deployment-retention.ts`) with the same meaning
 * it has there — time since a real terminal signal — so a debrief or replay
 * that can still read the deployment rows can still read the coordination
 * state they refer to.
 */
const COORDINATION_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The TTL value (epoch seconds) to stamp on a row written or touched at `nowMs`. */
export function coordinationStateExpiresAt(nowMs: number): number {
  return Math.floor((nowMs + COORDINATION_STATE_RETENTION_MS) / 1000);
}

/**
 * Whether a row carrying `expiresAt` should have its TTL pushed out now.
 *
 * Refreshing on every tick would be one write per namespace per minute for a
 * row nothing changed. Refreshing once the row is past the halfway mark costs
 * roughly one write per namespace per half-window while still leaving that same
 * half-window of margin before anything could expire — so a few missed ticks,
 * or a dispatcher outage, cannot cost a live match.
 *
 * A row with no `expiresAt` predates the TTL and is refreshed on sight, which
 * is also how those rows acquire one.
 */
export function shouldRefreshCoordinationTtl(
  expiresAt: number | undefined,
  nowMs: number,
): boolean {
  if (expiresAt === undefined) return true;
  const halfWindowMs = COORDINATION_STATE_RETENTION_MS / 2;
  return expiresAt * 1000 - nowMs <= halfWindowMs;
}

/**
 * [Issue #3149] Guards the version a conditional coordination delete may be
 * built from.
 *
 * 0 is the sentinel for "no row" everywhere else in this port
 * (`writeCoordinationState` treats it as the create case), and there is no
 * conditional delete that can express "delete the row that is not there".
 * Accepting it would leave a backend with two options, both wrong: refuse
 * every such call (making cleanup look permanently raced) or delete
 * unconditionally (reintroducing the race the condition exists to close). A
 * thrown error puts the mistake at the call site, where it can be fixed.
 */
export function assertConditionableVersion(expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    throw new RangeError(
      `A conditional coordination delete needs the positive version that was read; got ${expectedVersion}.`,
    );
  }
}

/**
 * [Issue #3133] Bytes of entropy behind one match secret.
 *
 * 32 bytes (256 bits, 64 hex characters) is the same size the rest of the
 * platform uses for material an attacker must not be able to search — it is far
 * beyond any offline guessing budget, and the value never leaves the server, so
 * there is no length constraint pulling the other way.
 */
const MATCH_SECRET_BYTES = 32;

/**
 * [Issue #3133] Mints one match's server-only secret.
 *
 * Coordination plugins that need unguessable material had nowhere to get it:
 * `CoordinationContext` carried only `eventId` and `teamIds`, both of which are
 * routing keys the portal hands to the participant's own browser. A plugin
 * seeding from `eventId` therefore published its hidden material, because the
 * problem repository is public and every derivation function in it is readable.
 *
 * The randomness source is the platform's, not the plugin's, so that a problem
 * cannot weaken it — and the value is issued exactly once per scope (see the
 * port's `ensureCoordinationMatchSecret`), because a secret that changed under
 * a running match would invalidate everything already derived from it.
 */
export function createCoordinationMatchSecret(
  randomBytes: (size: number) => { toString(encoding: "hex"): string },
): string {
  return randomBytes(MATCH_SECRET_BYTES).toString("hex");
}
