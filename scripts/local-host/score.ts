import {
  type PinnedScorePolicy,
  projectScore,
  projectScoreTimeline,
} from "@tenkacloud/problem-sdk/internal";
import type { HostedEvent, ScoreEvent } from "./model";

/** Read only the event's pinned definitions; never re-open the current catalog. */
export function scorePolicies(event: HostedEvent): readonly PinnedScorePolicy[] {
  return event.problems.map((problem) => {
    const definition = JSON.parse(problem.definition) as { scoreFloor?: unknown };
    if (
      definition.scoreFloor !== undefined &&
      (typeof definition.scoreFloor !== "number" || !Number.isFinite(definition.scoreFloor))
    )
      throw new Error(`Invalid pinned score floor for ${problem.problemId}.`);
    return {
      problemId: problem.problemId,
      ...(definition.scoreFloor !== undefined ? { scoreFloor: definition.scoreFloor } : {}),
    };
  });
}

export function projectedScore(event: HostedEvent, entries: readonly ScoreEvent[]) {
  return projectScore(scorePolicies(event), entries);
}

export function projectedTimeline(event: HostedEvent, entries: readonly ScoreEvent[]) {
  return projectScoreTimeline(scorePolicies(event), entries);
}
