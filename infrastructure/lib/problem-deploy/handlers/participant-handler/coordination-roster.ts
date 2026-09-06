import {
  type ParticipantDeploymentsTableSharedResources,
  resolveDeploymentsRepository,
} from "./shared.js";

/**
 * The event roster a coordination plugin's `initialState(ctx)` is built from.
 *
 * Two hosts materialise a namespace: the participant op / projection path
 * (`makeCoordinationScopeResolver`) and the scoring-driven tick
 * (`coordination-tick.ts`). `initialState` is the only hook that receives
 * `ctx`, so whichever host runs first decides what the plugin knows about the
 * teams for the whole match. Both therefore resolve the roster HERE, from the
 * same rows, by the same rule -- a difference between them is a different
 * initial state depending on who won the race. [Issue #3187] is what that
 * looks like: the tick runs every minute from the moment the event starts, so
 * it wins against the first participant to open the portal, and it used to
 * pass ids alone. Every team was a ULID for the rest of the match, even after
 * #3172 had wired names into the op path.
 *
 * The roster is every team with a deployment row for the SAME problem in the
 * same (tenant, event), sorted by teamId. Sorting is the race defence itself
 * (Issue #3053): whichever request materialises the state, `initialState(ctx)`
 * gets the same input. Status is deliberately not filtered -- dropping a
 * mid-deploy team would make the roster depend on deploy timing, which is the
 * same race again.
 *
 * `knownTeamIds` are always on the roster: the requester on the op path, the
 * teams the scoring pass observed on the tick path. A failed roster query
 * degrades to those rather than failing the route or the tick.
 *
 * Known limit: the state is materialised once. A team that deploys after that
 * does not appear in `state.teams` (the SDK has no roster re-resolution hook)
 * and a team renamed after the match starts keeps its old name. Operators
 * start the match after every team has deployed.
 */
export interface EventRosterTarget {
  readonly tenantId: string;
  readonly eventId: string;
  readonly problemId: string;
  /** Team ids the caller already knows; on the roster whether or not the query succeeds. */
  readonly knownTeamIds: readonly string[];
  /** A durable reset cannot commit an incomplete roster after a failed query. */
  readonly requireComplete?: boolean;
}

export interface EventRoster {
  /** teamId 昇順 (= どの host が先に materialize しても `initialState(ctx)` の入力が同一)。 */
  readonly teamIds: readonly string[];
  /**
   * [Issue #3172] teamId → display name. A team with no name at all is left
   * out rather than mapped to an empty string, so the plugin's own fallback
   * to the id is what runs.
   */
  readonly teamNames: Readonly<Record<string, string>>;
}

export async function resolveEventRoster(
  shared: ParticipantDeploymentsTableSharedResources,
  target: EventRosterTarget,
): Promise<EventRoster> {
  const roster = new Set<string>(target.knownTeamIds);
  const teamNames: Record<string, string> = {};
  try {
    const repository = await resolveDeploymentsRepository(shared);
    const rows = await repository.listByTenantAndEvent(target.tenantId, target.eventId);
    for (const row of rows) {
      if (row.problemId !== target.problemId || typeof row.teamId !== "string" || !row.teamId) {
        continue;
      }
      roster.add(row.teamId);
      // `displayTeamName ?? teamName`, the order the leaderboard resolves.
      const name = trimmedString(row.displayTeamName) || trimmedString(row.teamName);
      if (name) teamNames[row.teamId] = name;
    }
  } catch (err) {
    if (target.requireComplete) throw err;
    // Neither host fails over this: the op path keeps serving the requester
    // and the tick keeps the batch moving. It is not silent either -- a match
    // that starts on the known ids alone is exactly what #3187 looked like on
    // live, and the warn is how an operator tells that apart from a real
    // roster of one.
    console.warn("[coordination] roster query failed; materialising with the known team ids only", {
      eventId: target.eventId,
      problemId: target.problemId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { teamIds: [...roster].sort(), teamNames };
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
