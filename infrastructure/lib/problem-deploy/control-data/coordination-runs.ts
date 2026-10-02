import { ulid } from "ulid";
import { createMatch, type LocalMatch } from "../../../../scripts/local-host/coordination-core.js";
import { assertOpen, assertPin, closedStatuses } from "./coordination-state.js";
import {
  type NativeCoordinationArtifact,
  NativeCoordinationError,
  type NativeCoordinationRun,
} from "./domain/coordination.js";
import type { EventRecord } from "./domain/events.js";

/** Compute initial scores without executing a tick or participant operation. */
export function initializedMatch(
  artifact: NativeCoordinationArtifact,
  roster: NativeCoordinationRun["roster"],
  eventId: string,
): LocalMatch {
  const match = createMatch(artifact.plugin, {
    eventId,
    teamIds: roster.map((team) => team.teamId),
    teamNames: Object.fromEntries(roster.map((team) => [team.teamId, team.teamName])),
  });
  const scores = artifact.plugin.teamScores?.(structuredClone(match.state)) ?? match.scores;
  coordinationScoreDeltas(
    scores,
    match.scores,
    roster.map((team) => team.teamId),
  );
  return { ...match, scores: { ...scores } };
}

export function coordinationScoreDeltas(
  scores: Record<string, number>,
  previous: Readonly<Record<string, number>>,
  teamIds: readonly string[],
): Record<string, number> {
  if (Object.keys(scores).some((teamId) => !teamIds.includes(teamId)))
    throw new NativeCoordinationError(503, "coordination_score_invalid");
  return Object.fromEntries(
    teamIds.map((teamId) => {
      const score = scores[teamId];
      const delta = (score ?? NaN) - (previous[teamId] ?? 0);
      if (typeof score !== "number" || !Number.isFinite(score) || !Number.isFinite(delta))
        throw new NativeCoordinationError(503, "coordination_score_invalid");
      return [teamId, delta];
    }),
  );
}

export function assertResetOpen(event: EventRecord, now: number): void {
  if (
    closedStatuses.has(event.status) ||
    (event.endsAt !== undefined && now >= Date.parse(event.endsAt))
  )
    throw new NativeCoordinationError(409, "event_ended");
  assertOpen(event, now);
}

/** Legacy first-run callers may omit the fence; a reset requires a refreshed run identity. */
export function assertOperationRun(
  run: Pick<NativeCoordinationRun, "runId" | "history">,
  operation: { readonly runId?: string } | undefined,
): void {
  if (
    operation &&
    (operation.runId === undefined ? Boolean(run.history?.length) : operation.runId !== run.runId)
  )
    throw new NativeCoordinationError(409, "coordination_run_changed");
}

/** A reset replaces the native subtotal, retaining other scorers and the event clock. */
export function resetRun(
  previous: NativeCoordinationRun,
  event: EventRecord,
  artifact: NativeCoordinationArtifact,
  now: number,
): { run: NativeCoordinationRun; deltas: Record<string, number> } {
  assertResetOpen(event, now);
  assertPin(previous, artifact);
  if (previous.closed) throw new NativeCoordinationError(409, "event_ended");
  if (previous.retiredRuns?.length)
    throw new NativeCoordinationError(503, "coordination_history_cleanup_pending");
  const match = initializedMatch(artifact, previous.roster, event.eventId);
  const history = [previous.runId, ...(previous.history ?? [])];
  const revision = previous.revision + 1;
  return {
    run: {
      eventId: previous.eventId,
      problemId: previous.problemId,
      runId: ulid(now),
      revision,
      history: history.slice(0, 2),
      retiredRuns: history.slice(2),
      snapshotLayout: "run",
      artifactDigest: previous.artifactDigest,
      pluginKey: previous.pluginKey,
      catalogKey: previous.catalogKey,
      roster: previous.roster,
      match: { ...match, version: revision },
      clock: previous.clock,
      closed: false,
      updatedAt: new Date(now).toISOString(),
    },
    deltas: coordinationScoreDeltas(
      match.scores,
      previous.match.scores,
      previous.roster.map((team) => team.teamId),
    ),
  };
}
