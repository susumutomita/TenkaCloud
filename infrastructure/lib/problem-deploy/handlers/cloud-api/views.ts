import type {
  LeaderboardResponse,
  ParticipantProblemView,
  ParticipantTeamView,
} from "@tenkacloud/portal-contracts";
import type { TeamScoreProjection } from "../../control-data/domain/deployment-work.js";
import type { DeploymentRecord } from "../../control-data/domain/deployments.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import type { TeamRecord } from "../../control-data/domain/teams.js";
import { organizerScoreTotalsSchema } from "./schema.js";

export function organizerScoreTotals(
  event: EventRecord,
  teams: readonly TeamRecord[],
  scores: readonly TeamScoreProjection[],
) {
  const roster = new Set(teams.map((team) => team.teamId));
  if (
    teams.some((team) => team.eventId !== event.eventId) ||
    scores.some((score) => score.eventId !== event.eventId || !roster.has(score.teamId)) ||
    new Set(scores.map((score) => score.teamId)).size !== scores.length
  )
    throw new Error("Organizer score projection scope mismatch.");
  const byTeam = new Map(scores.map((score) => [score.teamId, score.score]));
  return organizerScoreTotalsSchema.parse({
    scoreHistoryAvailable: false,
    scoreEventsByTeam: teams.map((team) => ({
      teamId: team.teamId,
      teamName: team.displayName ?? team.internalSlug,
      projectedTotal: byTeam.get(team.teamId) ?? 0,
      events: [],
    })),
  });
}

export function eventSummary(event: EventRecord) {
  const { problems, ...summary } = event;
  return { ...summary, problemCount: problems.length };
}
export function teamSummary(team: TeamRecord, reveal: boolean) {
  return {
    teamId: team.teamId,
    internalSlug: team.internalSlug,
    ...(team.displayName ? { displayName: team.displayName } : {}),
    ...(team.awsAccountId ? { awsAccountId: team.awsAccountId } : {}),
    ...(reveal && !team.accessRevoked ? { teamLoginKey: team.teamLoginKey } : {}),
  };
}
const inactive = new Set(["DELETING", "DELETED", "EXPIRED", "AUTO_DELETED"]);
export function participantView(
  team: TeamRecord,
  deployments: readonly DeploymentRecord[],
  participantAwsCli = false,
  native: readonly ParticipantProblemView[] = [],
): ParticipantTeamView {
  return {
    team: {
      teamName: team.displayName ?? team.internalSlug,
      teamNameSetByCompetitor: team.displayName !== undefined,
      eventId: team.eventId,
      teamId: team.teamId,
    },
    problems: [
      ...deployments
        .filter(
          (row) =>
            row.eventId === team.eventId && row.teamId === team.teamId && !inactive.has(row.status),
        )
        .map<ParticipantProblemView>((row) => ({
          jobId: row.jobId,
          problemId: row.problemId,
          region: row.region,
          awsAccountId: row.awsAccountId,
          status: row.status,
          expiresAt: row.expiresAt,
          score: row.score,
          // Endpoint/answer projection is supplied with runner wiring; never expose arbitrary raw outputs.
          stackOutputs: { ...row.publicOutputs },
          ...(row.scoring
            ? {
                scoring: {
                  kind: row.scoring.kind,
                  points: row.scoring.points,
                  flagSubmitted: row.flagSubmitted === true,
                },
              }
            : {}),
          ...(row.failureReason ? { failureReason: row.failureReason } : {}),
          ...(row.createdAt ? { createdAt: row.createdAt } : {}),
          accessCapabilities:
            participantAwsCli &&
            row.problemId === "hello-world" &&
            row.status === "COMPLETE" &&
            !row.teardownStatus
              ? ["cli-credentials"]
              : [],
          deployLog: { cursor: row.jobId, entries: [] },
        })),
      ...native,
    ],
  };
}
/** Historical leaderboard projection from deployment scores, with the same freeze response contract. */
export function leaderboard(
  event: EventRecord,
  teams: readonly TeamRecord[],
  scores: readonly TeamScoreProjection[],
  myTeamId: string,
  now: number,
): LeaderboardResponse {
  const end = event.endsAt ? Date.parse(event.endsAt) : Number.NaN;
  const freeze = event.scoreboardFreezeMinutes ?? 30;
  const frozen = Number.isFinite(end) && freeze > 0 && now >= end - freeze * 60_000 && now < end;
  const entries = teams
    .filter((team) => team.eventId === event.eventId)
    .map((team) => {
      const projection = scores.find(
        (row) => row.eventId === event.eventId && row.teamId === team.teamId,
      );
      return {
        rank: 0,
        teamId: team.teamId,
        teamName: team.displayName ?? team.internalSlug,
        score: projection?.score ?? 0,
        completedProblems: projection?.completedProblems ?? 0,
        totalProblems: event.problems.length,
        isMyTeam: team.teamId === myTeamId,
      };
    });
  entries.sort(
    (a, b) =>
      b.score - a.score || a.teamName.localeCompare(b.teamName) || a.teamId.localeCompare(b.teamId),
  );
  return {
    eventId: event.eventId,
    entries: frozen ? [] : entries.map((entry, index) => ({ ...entry, rank: index + 1 })),
    scoreboardFrozen: frozen,
    ...(event.endsAt ? { endsAt: event.endsAt } : {}),
  };
}
