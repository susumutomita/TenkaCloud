import {
  type CoordinationStateBudget,
  checkCoordinationCapacity,
  parseCoordinationStateForecast,
} from "../../control-data/domain/coordination-budget.js";
import { logDeployTrace } from "../shared/trace-log.js";

/**
 * [Issue #3169] Telling the operator at event creation what the deploy will do.
 *
 * The same forecast the bulk-deploy preflight refuses on, reported one step
 * earlier and without refusing. Creation is the moment the team roster is
 * decided and the cheapest moment to change it; deploy is where the decision is
 * enforced, because that is where nothing has happened yet that would have to
 * be unwound.
 *
 * Warnings never fail the request. An operator recreating an event that no
 * longer fits — a backend changed under them, a problem grew — still needs to
 * be able to create it, look at it, and decide.
 */
export function warnOnCoordinationCapacity(args: {
  readonly problems: readonly { readonly problemId: string }[];
  readonly teamCount: number;
  /** Absent is read as "nothing declared" — see the bulk-deploy preflight. */
  readonly problemsCoordination?: Readonly<Record<string, unknown>>;
  readonly budget: CoordinationStateBudget;
  readonly tenantId: string;
  readonly eventId: string;
}): readonly string[] {
  const warnings: string[] = [];
  for (const problem of args.problems) {
    const forecast = parseCoordinationStateForecast(args.problemsCoordination?.[problem.problemId]);
    if (!forecast) continue;
    const verdict = checkCoordinationCapacity(forecast, args.teamCount, args.budget);
    if (verdict.kind === "fits") continue;
    const over = verdict.kind === "over";
    warnings.push(
      `problem "${problem.problemId}" ${over ? "will not fit" : "is close to the limit for"} ` +
        `${args.teamCount} teams on the ${verdict.budget.backend} backend ` +
        `(forecast ${verdict.forecastBytes} bytes, ceiling ${verdict.budget.maxBytes}); ` +
        `this backend fits at most ${verdict.maxTeams} teams` +
        (over ? " — deploying this event will be refused" : ""),
    );
    logDeployTrace(
      over ? "event.create.coordination.will-not-fit" : "event.create.coordination.tight",
      {
        tenantId: args.tenantId,
        eventId: args.eventId,
        problemIds: problem.problemId,
        teams: args.teamCount,
        forecastBytes: verdict.forecastBytes,
        maxTeams: verdict.maxTeams,
        backend: verdict.budget.backend,
      },
    );
  }
  return warnings;
}
