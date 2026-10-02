import type {
  CloudRepository,
  EventCreationReceipt,
} from "../../lib/problem-deploy/control-data/cloud-repository.js";
import { DeploymentConflict } from "../../lib/problem-deploy/control-data/domain/deployment-work.js";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/domain/deployments.js";
import {
  CLOUD_EVENT_LIMITS,
  type EventRecord,
} from "../../lib/problem-deploy/control-data/domain/events.js";
import type { TeamRecord } from "../../lib/problem-deploy/control-data/domain/teams.js";

/** HTTP unit-test fixture only; DynamoDB transaction behavior is checked separately. */
export class FakeRepository implements CloudRepository {
  readonly eventLimits = CLOUD_EVENT_LIMITS;
  readonly events = new Map<string, EventRecord>();
  readonly teams = new Map<string, TeamRecord>();
  deployments: DeploymentRecord[] = [];
  readonly creationReceipts = new Map<string, EventCreationReceipt>();
  replayEventCreation(scope: string, key: string, requestHash: string) {
    const receipt = this.creationReceipts.get(`${scope}/${key}`);
    if (receipt && receipt.requestHash !== requestHash)
      return Promise.reject(new DeploymentConflict("idempotency_key_reused"));
    return Promise.resolve(receipt?.response);
  }
  createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
    receipt?: EventCreationReceipt,
  ): Promise<"created" | "conflict"> {
    if (
      this.events.has(event.eventId) ||
      (receipt && this.creationReceipts.has(`${receipt.scope}/${receipt.key}`))
    )
      return Promise.resolve("conflict");
    if (receipt) this.creationReceipts.set(`${receipt.scope}/${receipt.key}`, receipt);
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
  listDeploymentsByTeam(eventId: string, teamId: string) {
    return Promise.resolve(
      this.deployments.filter((row) => row.eventId === eventId && row.teamId === teamId),
    );
  }
  listTeamScores(eventId: string) {
    return Promise.resolve(
      [...this.teams.values()]
        .filter((team) => team.eventId === eventId)
        .map((team) => {
          const jobs = this.deployments.filter(
            (job) =>
              job.eventId === eventId &&
              job.teamId === team.teamId &&
              !["DELETED", "DELETING", "AUTO_DELETED", "EXPIRED"].includes(job.status),
          );
          return {
            eventId,
            teamId: team.teamId,
            score: jobs.reduce((sum, job) => sum + job.score, 0),
            completedProblems: jobs.filter((job) => job.status === "COMPLETE").length,
          };
        }),
    );
  }
  listDeploymentsByEvent(eventId: string) {
    return Promise.resolve(this.deployments.filter((row) => row.eventId === eventId));
  }
}
