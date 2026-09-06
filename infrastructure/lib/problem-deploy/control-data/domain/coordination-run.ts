import { randomUUID } from "node:crypto";
import { type CoordinationStateScope, DEFAULT_COORDINATION_RUN_ID } from "./coordination-scope.js";

/**
 * [Issue #3153] Real runs, replacing the constant run id.
 *
 * ## What was wrong
 *
 * `CoordinationStateScope` has always had four dimensions —
 * `tenant x event x problem x run` — but `runId` was the literal `"default"`.
 * The fourth dimension existed in the type and nowhere else.
 *
 * That made "reset this match" mean "delete this namespace"
 * (#3126 / #3135). It works, and it throws away the previous match: state,
 * ledger, scores and artifacts all go, with nothing left to look at
 * afterwards. An operator who resets a match because something went wrong has
 * destroyed the evidence of what went wrong.
 *
 * ## What replaces it
 *
 * A pointer per `(tenant, event, problem)` naming the run that is current, with
 * the runs before it kept as history. Resetting mints a NEW run id and moves
 * the old one into that history, so the previous match's state and artifacts
 * survive under a namespace nothing writes to any more.
 *
 * ## Why a run id is never reused
 *
 * Two things depend on it. The artifact store's tombstone (#3152) voids a
 * prefix, and a reused run id would walk back into a voided prefix. And
 * "history" is only meaningful if a retired run's bytes cannot be confused with
 * a live run's. Ids are therefore random, never derived from the scope, and
 * never recycled.
 *
 * ## Why the FIRST run keeps the old constant
 *
 * A pointer that does not exist yet resolves to
 * {@link DEFAULT_COORDINATION_RUN_ID}, not to a freshly minted id. Every match
 * in flight when this ships is stored under `"default"`, and minting a new id
 * on first read would move all of them to a namespace with no state in it —
 * every live match would silently restart from `initialState`. Adopting the
 * constant costs one branch and keeps them playing; the first reset after this
 * change moves that `(event, problem)` onto real ids and it never goes back.
 */

/** The `(tenant, event, problem)` triple a run pointer belongs to. */
export interface CoordinationRunKey {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
}

export interface CoordinationRunPointer {
  /** The run participants are playing right now. */
  readonly runId: string;
  /** When this run was started (ISO 8601). */
  readonly startedAt: string;
  /**
   * Previously current runs, most recent first, still readable under their own
   * scopes.
   */
  readonly history: readonly string[];
  /** Accepted reset still owes one durable initial state and its initial scores. */
  readonly pendingInitialization?: true;
}

/**
 * How many retired runs are kept alongside the current one.
 *
 * Three is a debrief, not an archive: an operator resetting a match wants the
 * one they just ended, and occasionally the one before it. Every retained run
 * is a full state row plus its artifacts, and #3151 measured what one of those
 * costs — 1.62 MB for a 99-team match — so the number that matters is not "how
 * many might someone want" but "how many can the platform hold without the
 * retention becoming the storage problem".
 *
 * Runs beyond the window are retired: their state and artifacts are deleted
 * when the rotation that pushes them out commits.
 */
export const COORDINATION_RUN_HISTORY_LIMIT = 3;

/**
 * Mints a run id.
 *
 * Random rather than sequential or derived. A counter would have to be stored
 * and could roll back — precisely the failure #3149 records, where a plugin
 * re-issued live ids after a cleanup shortened the list it counted from — and a
 * value derived from the scope would repeat the moment the same scope was reset
 * twice, walking a new match into the previous one's tombstoned artifact
 * prefix.
 *
 * `r` prefixed so a run id is never mistaken for the `"default"` constant or
 * for a problem id at a glance, and hyphen-free so it satisfies the artifact
 * key component rules without escaping.
 */
export function createCoordinationRunId(newUuid: () => string = randomUUID): string {
  return `r${newUuid().replaceAll("-", "")}`;
}

/**
 * The pointer an absent row means.
 *
 * Not a placeholder: this IS the first run of every `(event, problem)`, and it
 * is what keeps a match that predates this change playable. See the module
 * docstring.
 */
export function initialCoordinationRunPointer(startedAt: string): CoordinationRunPointer {
  return { runId: DEFAULT_COORDINATION_RUN_ID, startedAt, history: [] };
}

/** The scope of one run of one problem. */
export function coordinationScopeForRun(
  key: CoordinationRunKey,
  runId: string,
): CoordinationStateScope {
  return { tenantId: key.tenantId, eventId: key.eventId, problemId: key.problemId, runId };
}

export interface CoordinationRunRotation {
  /** The pointer to store. */
  readonly pointer: CoordinationRunPointer;
  /**
   * Runs pushed out of the history window by this rotation. Their state and
   * artifacts are deleted once the pointer write commits — not before, so a
   * rotation that loses its race deletes nothing.
   */
  readonly retired: readonly string[];
}

/**
 * Computes the pointer that results from starting `nextRunId`.
 *
 * A pure function so the ordering rule — retire only what the window pushes
 * out, and only after the write lands — is stated once and testable without a
 * backend.
 */
export function rotateCoordinationRunPointer(
  current: CoordinationRunPointer,
  nextRunId: string,
  startedAt: string,
  historyLimit: number = COORDINATION_RUN_HISTORY_LIMIT,
): CoordinationRunRotation {
  const history = [current.runId, ...current.history];
  // The window counts the current run too: `historyLimit` is how many runs
  // exist at all, so a limit of 3 keeps the new run plus the two before it.
  const kept = history.slice(0, Math.max(historyLimit - 1, 0));
  return {
    pointer: { runId: nextRunId, startedAt, history: kept, pendingInitialization: true },
    retired: history.slice(kept.length),
  };
}
