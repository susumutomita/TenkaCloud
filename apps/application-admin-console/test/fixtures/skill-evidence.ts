import { skillDeclarations } from "../../../../packages/portal-contracts/src/skill-evidence";
import battle from "../../../../problems/battles/hello-world-battle/metadata.json";
import challenge from "../../../../problems/challenges/hello-world/metadata.json";
import type { EventDetail, TeamScoreEventView } from "../../src/api/events-client";

export function evidenceFixture(): EventDetail {
  const event = (problemId: string, source: "flag" | "uptime"): TeamScoreEventView => ({
    jobId: `${problemId}-alpha`,
    problemId,
    source,
    points: 100,
    result: "ok",
    occurredAt: "2026-10-01T00:01:00Z",
  });
  return {
    eventId: "01KQZRZSTT6EQC9JVK4FQKRKKM",
    name: "Skill Evidence rehearsal",
    status: "ENDED",
    teamCount: 2,
    problemCount: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T01:00:00Z",
    expiresAt: 0,
    startsAt: "2026-10-01T00:00:00Z",
    endsAt: "2026-10-01T01:00:00Z",
    teams: ["alpha", "beta"].map((id) => ({ teamId: id, internalSlug: id })),
    problems: [challenge, battle].map((metadata) => ({
      problemId: metadata.id,
      defaultRegion: "local",
      skillCatalog: {
        revision: `sha256:${"a".repeat(64)}`,
        scoringKind: metadata.scoring.kind,
        declarations: skillDeclarations(metadata.skillEvidence) ?? [],
      },
    })),
    deploymentsByProblem: Object.fromEntries(
      [challenge, battle].map((metadata) => [
        metadata.id,
        ["alpha", "beta"].map((id) => ({
          jobId: `${metadata.id}-${id}`,
          teamId: id,
          status: "DELETED" as const,
        })),
      ]),
    ),
    scoreEventsByTeam: [
      {
        teamId: "alpha",
        teamName: "alpha",
        projectedTotal: 200,
        events: [event(challenge.id, "flag"), event(battle.id, "uptime")],
      },
      { teamId: "beta", teamName: "beta", projectedTotal: 100, events: [] },
    ],
  };
}
