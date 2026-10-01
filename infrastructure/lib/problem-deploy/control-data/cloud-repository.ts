import type { TeamScoreProjection } from "./domain/deployment-work.js";
import type { DeploymentRecord } from "./domain/deployments.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
export interface EventCreationReceipt {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly response: unknown;
}
export interface CloudRepository {
  replayEventCreation(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | undefined>;
  createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
    receipt?: EventCreationReceipt,
  ): Promise<"created" | "conflict">;
  getEvent(eventId: string): Promise<EventRecord | undefined>;
  listEvents(): Promise<readonly EventRecord[]>;
  getTeam(eventId: string, teamId: string): Promise<TeamRecord | undefined>;
  listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]>;
  authenticateTeam(key: string, now: number): Promise<TeamRecord | undefined>;
  rotateTeamAccess(
    team: TeamRecord,
    replacementKey: string | undefined,
    at: string,
  ): Promise<"updated" | "conflict">;
  listDeploymentsByTeam(eventId: string, teamId: string): Promise<readonly DeploymentRecord[]>;
  listTeamScores(eventId: string): Promise<readonly TeamScoreProjection[]>;
  listDeploymentsByEvent(eventId: string): Promise<readonly DeploymentRecord[]>;
}
