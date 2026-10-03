import {
  type CoordinationStateBudget,
  checkCoordinationCapacity,
  parseCoordinationStateForecast,
} from "../../../control-data/domain/coordination-budget.js";

/**
 * [Issue #3169] Refusing an event that cannot fit before it is deployed.
 *
 * ## Why this exists next to #3151's runtime guard rather than instead of it
 *
 * #3151 weighs each write and refuses the one that would not fit. That is
 * correct and it is also the worst possible moment to find out: the event is
 * live, the participants are mid-match, and the only remaining options are bad
 * ones. Every input to the answer — how many teams, which problem, which
 * backend — is already known when the operator presses deploy, so the same
 * ceiling can be applied while the answer is still cheap.
 *
 * The two are not redundant. This one extrapolates from a declaration and can
 * therefore be wrong in either direction if a problem's growth changes; the
 * runtime guard measures what is actually being written and cannot be. Removing
 * either leaves a real hole.
 *
 * ## Why the whole roster, not the teams being deployed now
 *
 * `bulkDeployEvent` runs against live events — late joiners, retries of failed
 * stacks — so a deploy often covers a subset. The coordination state is not per
 * deployment: one row holds the match for every team on that problem in that
 * event. Sizing a partial deploy against its own subset would pass every
 * individual deploy while the match they share grew past the ceiling, which is
 * exactly the failure this check exists to prevent.
 */
export interface CoordinationCapacityRefusal {
  readonly problemId: string;
  readonly teamCount: number;
  readonly forecastBytes: number;
  readonly maxTeams: number;
  readonly budget: CoordinationStateBudget;
}

export interface CoordinationCapacityReport {
  /** Problems whose forecast exceeds the ceiling. Non-empty means refuse. */
  readonly refusals: readonly CoordinationCapacityRefusal[];
  /** Problems forecast past the warning line but still inside the ceiling. */
  readonly tight: readonly CoordinationCapacityRefusal[];
}

/**
 * Checks every coordination problem in this deploy against the backend budget.
 *
 * A problem that declares no state budget is skipped rather than guessed at.
 * Every coordination problem in the catalog predates the declaration, so
 * assuming a number for them would either block events that are fine or admit
 * events that are not; both are worse than the status quo, which is that the
 * runtime guard still holds the line.
 */
export function checkBulkDeployCoordinationCapacity(args: {
  readonly problems: readonly { readonly problemId: string }[];
  /** Every team in the event, not only the teams this deploy covers. */
  readonly eventTeamCount: number;
  /** Actual whole roster, to include long or escaped legacy IDs in the host reserve. */
  readonly eventTeamIds?: readonly string[];
  /**
   * Per-problem `interTeamCoordination`. Optional, and an absent map is read as
   * "nothing declared" rather than as an error: that is the same outcome as a
   * problem that declares no `stateBudget`, which is the designed behaviour of
   * this check. Throwing here would let a shape problem in an unrelated part of
   * the catalog take down every bulk deploy, including the ones with no
   * coordination problem in them at all.
   */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  readonly budget: CoordinationStateBudget;
}): CoordinationCapacityReport {
  const refusals: CoordinationCapacityRefusal[] = [];
  const tight: CoordinationCapacityRefusal[] = [];
  for (const problem of args.problems) {
    const forecast = parseCoordinationStateForecast(args.problemsCoordination?.[problem.problemId]);
    if (!forecast) continue;
    const verdict = checkCoordinationCapacity(
      forecast,
      args.eventTeamCount,
      args.budget,
      args.eventTeamIds,
    );
    if (verdict.kind === "fits") continue;
    const entry: CoordinationCapacityRefusal = {
      problemId: problem.problemId,
      teamCount: args.eventTeamCount,
      forecastBytes: verdict.forecastBytes,
      maxTeams: verdict.maxTeams,
      budget: verdict.budget,
    };
    if (verdict.kind === "over") refusals.push(entry);
    else tight.push(entry);
  }
  return { refusals, tight };
}

/**
 * The sentence an operator reads.
 *
 * Names the backend, the problem, both numbers and the team count that would
 * fit, because "too big" alone sends them to read the source to find out what
 * to do instead.
 */
export function describeCapacityRefusal(refusal: CoordinationCapacityRefusal): string {
  return (
    `problem "${refusal.problemId}" is forecast to need ${refusal.forecastBytes} bytes of ` +
    `coordination state for ${refusal.teamCount} teams, over the ${refusal.budget.backend} ` +
    `ceiling of ${refusal.budget.maxBytes} bytes; this backend fits at most ${refusal.maxTeams} teams`
  );
}
