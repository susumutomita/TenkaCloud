import { LOCAL_COORDINATION_STATE_LIMIT, requiredCoordinationTeams } from "./coordination-catalog";
import { HostError, type Problem } from "./model";

/** Reject an incompatible roster before issuing keys or preparing a match. */
export function assertCoordinationRoster(problems: readonly Problem[], teams: number): void {
  for (const problem of problems) {
    if (problem.runtime !== "coordination") continue;
    const required = requiredCoordinationTeams(problem.problemId);
    const { metadata } = JSON.parse(problem.definition) as { metadata: Record<string, unknown> };
    const budget = (
      metadata?.interTeamCoordination as
        | { stateBudget?: { baseBytes: number; bytesPerTeam: number } }
        | undefined
    )?.stateBudget;
    if (
      budget &&
      (!Number.isSafeInteger(budget.baseBytes) ||
        budget.baseBytes < 0 ||
        !Number.isSafeInteger(budget.bytesPerTeam) ||
        budget.bytesPerTeam < 1 ||
        budget.baseBytes + budget.bytesPerTeam * teams > LOCAL_COORDINATION_STATE_LIMIT)
    )
      throw new HostError(
        422,
        `${problem.name} exceeds the local coordination state budget for ${teams} teams.`,
      );
    if (required !== undefined && teams !== required)
      throw new HostError(422, `${problem.name} requires exactly ${required} teams.`);
  }
}
