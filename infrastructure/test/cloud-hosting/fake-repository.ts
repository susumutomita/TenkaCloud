import type { CloudRepository } from "../../lib/problem-deploy/control-data/cloud-repository.js";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/domain/deployments.js";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";

/** HTTP unit-test fixture only; DynamoDB transaction behavior is checked separately. */
export class FakeRepository implements CloudRepository {
  readonly events = new Map<string, EventRecord>();
  readonly teams = new Map<string, TeamRecord>();
  deployments: DeploymentRecord[] = [];
  createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
  ): Promise<"created" | "conflict"> {
    if (this.events.has(event.eventId)) return Promise.resolve("conflict");
    this.events.set(event.eventId, event);
    for (const team of teams) this.teams.set(`${team.eventId}/${team.teamId}`, team);
    return Promise.resolve("created");
  }
  getEvent(id: string) {
    return Promise.resolve(this.events.get(id));
  }
  listEvents() {
    return Promise.resolve([...this.events.values()]);
  }
  getTeam(eventId: string, teamId: string) {
    return Promise.resolve(this.teams.get(`${eventId}/${teamId}`));
  }
  listTeamsByEvent(eventId: string) {
    return Promise.resolve([...this.teams.values()].filter((team) => team.eventId === eventId));
  }
  authenticateTeam(key: string, now: number) {
    return Promise.resolve(
      [...this.teams.values()].find(
        (team) => team.teamLoginKey === key && !team.accessRevoked && team.expiresAt > now / 1000,
      ),
    );
  }
  rotateTeamAccess(
    team: TeamRecord,
    replacementKey: string | undefined,
    at: string,
  ): Promise<"updated" | "conflict"> {
    const key = `${team.eventId}/${team.teamId}`;
    if (this.teams.get(key)?.authVersion !== team.authVersion) return Promise.resolve("conflict");
    this.teams.set(key, {
      ...team,
      teamLoginKey: replacementKey ?? team.teamLoginKey,
      authVersion: team.authVersion + 1,
      updatedAt: at,
      accessRevoked: replacementKey === undefined,
    });
    return Promise.resolve("updated");
  }
  listDeploymentsByEvent(eventId: string) {
    return Promise.resolve(this.deployments.filter((row) => row.eventId === eventId));
  }
}
