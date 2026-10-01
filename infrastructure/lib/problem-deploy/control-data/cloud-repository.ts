import type { DeploymentRecord } from "./domain/deployments.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
export interface CloudRepository {
  createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
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
  listDeploymentsByEvent(eventId: string): Promise<readonly DeploymentRecord[]>;
}
