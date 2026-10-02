import { z } from "zod";
import { digest, eventSchema, ID, KEY, scoreSchema, teamSchema } from "./cloud-records.js";
import type { CloudRepository, EventCreationReceipt } from "./cloud-repository.js";
import { deploymentSchema } from "./deployment-records.js";
import { NATIVE_COORDINATION_PROBLEM } from "./domain/coordination.js";
import { DeploymentConflict } from "./domain/deployment-work.js";
import type { DeploymentRecord } from "./domain/deployments.js";
import { type CloudEventLimits, type EventRecord, SQL_EVENT_LIMITS } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import {
  type InstallationControl,
  type InstallationScope,
  installationControlSchema,
  installationScopeDigest,
} from "./installation-control.js";
import { assertEventId, assertTeamId, sqlPayload } from "./sql-cloud-records.js";
import type { SqlExecutor, SqlRow, SqlStatement } from "./sql-port.js";
import { sqlChangesGuard, sqlCommit, sqlGuard, sqlIntakeGuard } from "./sql-transaction.js";

function parseEvent(row: SqlRow): EventRecord {
  const event = eventSchema.parse(sqlPayload(row));
  if (event.eventId !== row.event_id) throw new Error("Event scope mismatch.");
  return event;
}
function parseTeam(row: SqlRow): TeamRecord {
  const team = teamSchema.parse(sqlPayload(row));
  if (team.eventId !== row.event_id || team.teamId !== row.team_id)
    throw new Error("Team scope mismatch.");
  return team;
}
function parseDeployment(row: SqlRow): DeploymentRecord {
  const job = deploymentSchema.parse(sqlPayload(row));
  if (
    job.jobId !== row.job_id ||
    job.eventId !== row.event_id ||
    job.teamId !== row.team_id ||
    job.problemId !== row.problem_id
  )
    throw new Error("Deployment scope mismatch.");
  return job;
}
/** Current cloud contracts backed by atomic libSQL write batches and durable records. */
export class SqlCloudRepository implements CloudRepository {
  readonly eventLimits: CloudEventLimits = SQL_EVENT_LIMITS;
  constructor(private readonly sql: SqlExecutor) {}

  async installationControl(): Promise<InstallationControl | undefined> {
    const row = await this.sql.get("SELECT payload FROM cloud_installation_control WHERE id = 1");
    if (!row) return undefined;
    const control = installationControlSchema.parse(sqlPayload(row));
    if (control.scopeDigest !== installationScopeDigest(control.scope))
      throw new DeploymentConflict("installation_scope_corrupt");
    return control;
  }
  async assertAcceptingInstallation(): Promise<void> {
    if (await this.installationControl()) throw new DeploymentConflict("installation_draining");
  }
  async stopAcceptingInstallation(
    scope: InstallationScope,
    at: string,
  ): Promise<InstallationControl> {
    const scopeDigest = installationScopeDigest(scope);
    const previous = await this.installationControl();
    if (previous) {
      if (previous.scopeDigest !== scopeDigest)
        throw new DeploymentConflict("installation_scope_changed");
      return previous;
    }
    const control = installationControlSchema.parse({
      scope,
      scopeDigest,
      status: "DRAINING",
      startedAt: at,
      updatedAt: at,
    });
    if (
      await sqlCommit(this.sql, [
        {
          sql: "INSERT INTO cloud_installation_control (id, payload) VALUES (1, ?)",
          params: [JSON.stringify(control)],
        },
      ])
    )
      return control;
    const current = await this.installationControl();
    if (!current || current.scopeDigest !== scopeDigest)
      throw new DeploymentConflict("installation_stop_conflict");
    return current;
  }
  async listStoppedInstallationEvents(scope: InstallationScope): Promise<EventRecord[]> {
    const control = await this.installationControl();
    if (!control || control.scopeDigest !== installationScopeDigest(scope))
      throw new DeploymentConflict("installation_not_stopped");
    return (await this.sql.all("SELECT event_id, payload FROM cloud_events ORDER BY event_id")).map(
      parseEvent,
    );
  }
  async confirmInstallationDrained(scope: InstallationScope, at: string): Promise<void> {
    const events = await this.listStoppedInstallationEvents(scope);
    if (
      events.some(
        (event) =>
          event.status !== "ARCHIVED" ||
          event.teardownExpected === undefined ||
          event.teardownExpected !== event.teardownCompleted,
      )
    )
      throw new DeploymentConflict("installation_events_not_drained");
    for (const event of events) {
      if (!event.problems.some((problem) => problem.problemId === NATIVE_COORDINATION_PROBLEM))
        continue;
      const { SqlDeploymentsCoordination } = await import("./sql-deployments-coordination.js");
      await new SqlDeploymentsCoordination(this.sql).closeFence(
        event.eventId,
        NATIVE_COORDINATION_PROBLEM,
      );
    }
    const control = await this.installationControl();
    if (!control || control.scopeDigest !== installationScopeDigest(scope))
      throw new DeploymentConflict("installation_scope_changed");
    if (control.status === "DRAINED") return;
    const next = installationControlSchema.parse({ ...control, status: "DRAINED", updatedAt: at });
    if (
      !(await sqlCommit(this.sql, [
        sqlGuard(`NOT EXISTS (SELECT 1 FROM cloud_events WHERE
        json_extract(payload, '$.status') <> 'ARCHIVED' OR
        json_extract(payload, '$.teardownExpected') IS NULL OR
        json_extract(payload, '$.teardownCompleted') IS NULL OR
        json_extract(payload, '$.teardownExpected') <> json_extract(payload, '$.teardownCompleted'))`),
        {
          sql: `UPDATE cloud_installation_control SET payload = ? WHERE id = 1
          AND json_extract(payload, '$.scopeDigest') = ? AND json_extract(payload, '$.status') = 'DRAINING'`,
          params: [JSON.stringify(next), control.scopeDigest],
        },
        sqlChangesGuard(),
      ]))
    )
      throw new DeploymentConflict("installation_drain_conflict");
  }
  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
    receipt?: EventCreationReceipt,
  ): Promise<"created" | "conflict"> {
    eventSchema.parse(event);
    if (
      teams.length === 0 ||
      teams.length > this.eventLimits.maxTeams ||
      event.teamCount !== teams.length
    )
      throw new Error(`Event creation supports 1-${this.eventLimits.maxTeams} teams.`);
    const ids = new Set<string>();
    const keys = new Set<string>();
    const slugs = new Set<string>();
    for (const team of teams) {
      teamSchema.parse(team);
      if (
        team.eventId !== event.eventId ||
        ids.has(team.teamId) ||
        keys.has(team.teamLoginKey) ||
        slugs.has(team.internalSlug)
      )
        throw new Error("Invalid or duplicate event team.");
      ids.add(team.teamId);
      keys.add(team.teamLoginKey);
      slugs.add(team.internalSlug);
    }
    const writes: SqlStatement[] = [
      sqlIntakeGuard(),
      {
        sql: "INSERT INTO cloud_events (event_id, payload) VALUES (?, ?)",
        params: [event.eventId, JSON.stringify(event)],
      },
    ];
    for (const team of teams)
      writes.push(
        {
          sql: "INSERT INTO cloud_teams (event_id, team_id, payload) VALUES (?, ?, ?)",
          params: [team.eventId, team.teamId, JSON.stringify(team)],
        },
        {
          sql: "INSERT INTO cloud_access_keys (key_hash, event_id, team_id, auth_version) VALUES (?, ?, ?, ?)",
          params: [digest(team.teamLoginKey), team.eventId, team.teamId, team.authVersion],
        },
      );
    if (receipt)
      writes.push({
        sql: "INSERT INTO cloud_create_receipts (receipt_hash, payload) VALUES (?, ?)",
        params: [
          digest(JSON.stringify([receipt.scope, receipt.key])),
          JSON.stringify({
            requestHash: receipt.requestHash,
            response: receipt.response,
            eventId: event.eventId,
          }),
        ],
      });
    if (await sqlCommit(this.sql, writes)) return "created";
    await this.assertAcceptingInstallation();
    return "conflict";
  }
  async replayEventCreation(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | undefined> {
    const row = await this.sql.get(
      "SELECT payload FROM cloud_create_receipts WHERE receipt_hash = ?",
      [digest(JSON.stringify([scope, key]))],
    );
    if (!row) return undefined;
    const receipt = z
      .object({ requestHash: z.string(), response: z.unknown() })
      .parse(sqlPayload(row));
    if (receipt.requestHash !== requestHash) throw new DeploymentConflict("idempotency_key_reused");
    if (!receipt.response) throw new Error("Corrupt event creation receipt.");
    return receipt.response;
  }
  async getEvent(eventId: string): Promise<EventRecord | undefined> {
    assertEventId(eventId);
    const row = await this.sql.get(
      "SELECT event_id, payload FROM cloud_events WHERE event_id = ?",
      [eventId],
    );
    return row ? parseEvent(row) : undefined;
  }
  async listEvents(): Promise<readonly EventRecord[]> {
    return (
      await this.sql.all(
        "SELECT event_id, payload FROM cloud_events ORDER BY json_extract(payload, '$.createdAt') DESC, event_id DESC",
      )
    ).map(parseEvent);
  }
  async getTeam(eventId: string, teamId: string): Promise<TeamRecord | undefined> {
    assertTeamId(eventId, teamId);
    const row = await this.sql.get(
      "SELECT event_id, team_id, payload FROM cloud_teams WHERE event_id = ? AND team_id = ?",
      [eventId, teamId],
    );
    return row ? parseTeam(row) : undefined;
  }
  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    assertEventId(eventId);
    return (
      await this.sql.all(
        "SELECT event_id, team_id, payload FROM cloud_teams WHERE event_id = ? ORDER BY team_id",
        [eventId],
      )
    ).map(parseTeam);
  }
  async authenticateTeam(key: string, now: number): Promise<TeamRecord | undefined> {
    if (!KEY.test(key)) return undefined;
    const row = await this.sql.get(
      "SELECT event_id, team_id, auth_version FROM cloud_access_keys WHERE key_hash = ?",
      [digest(key)],
    );
    if (!row) return undefined;
    const access = z
      .object({
        event_id: z.string().regex(ID),
        team_id: z.string().regex(ID),
        auth_version: z.number().int().positive(),
      })
      .parse(row);
    const team = await this.getTeam(access.event_id, access.team_id);
    if (
      !team ||
      team.accessRevoked ||
      team.authVersion !== access.auth_version ||
      digest(team.teamLoginKey) !== digest(key) ||
      team.expiresAt <= Math.floor(now / 1000)
    )
      return undefined;
    const event = await this.getEvent(team.eventId);
    return event &&
      event.expiresAt > Math.floor(now / 1000) &&
      event.status !== "ARCHIVED" &&
      event.status !== "TEARDOWN"
      ? team
      : undefined;
  }
  async rotateTeamAccess(
    team: TeamRecord,
    replacementKey: string | undefined,
    at: string,
  ): Promise<"updated" | "conflict"> {
    teamSchema.parse(team);
    if (replacementKey === team.teamLoginKey) throw new Error("Replacement key must be new.");
    const next = teamSchema.parse({
      ...team,
      teamLoginKey: replacementKey ?? team.teamLoginKey,
      authVersion: team.authVersion + 1,
      accessRevoked: replacementKey === undefined,
      updatedAt: at,
    });
    const writes: SqlStatement[] = [
      {
        sql: "UPDATE cloud_teams SET payload = ? WHERE event_id = ? AND team_id = ? AND json_extract(payload, '$.authVersion') = ?",
        params: [JSON.stringify(next), team.eventId, team.teamId, team.authVersion],
      },
      sqlChangesGuard(),
      {
        sql: "DELETE FROM cloud_access_keys WHERE key_hash = ?",
        params: [digest(team.teamLoginKey)],
      },
    ];
    if (replacementKey)
      writes.push({
        sql: "INSERT INTO cloud_access_keys (key_hash, event_id, team_id, auth_version) VALUES (?, ?, ?, ?)",
        params: [digest(replacementKey), team.eventId, team.teamId, next.authVersion],
      });
    return (await sqlCommit(this.sql, writes)) ? "updated" : "conflict";
  }
  async listDeploymentsByTeam(
    eventId: string,
    teamId: string,
  ): Promise<readonly DeploymentRecord[]> {
    assertTeamId(eventId, teamId);
    return (
      await this.sql.all(
        "SELECT job_id, event_id, team_id, problem_id, payload FROM cloud_deployments WHERE event_id = ? AND team_id = ? ORDER BY problem_id, job_id",
        [eventId, teamId],
      )
    ).map(parseDeployment);
  }
  async listTeamScores(eventId: string) {
    assertEventId(eventId);
    return (
      await this.sql.all(
        "SELECT event_id, team_id, payload FROM cloud_team_scores WHERE event_id = ? ORDER BY team_id",
        [eventId],
      )
    ).map((row) => {
      const score = scoreSchema.parse(sqlPayload(row));
      if (score.eventId !== row.event_id || score.teamId !== row.team_id)
        throw new Error("Score projection scope mismatch.");
      return score;
    });
  }
  async listDeploymentsByEvent(eventId: string): Promise<readonly DeploymentRecord[]> {
    assertEventId(eventId);
    return (
      await this.sql.all(
        "SELECT job_id, event_id, team_id, problem_id, payload FROM cloud_deployments WHERE event_id = ? ORDER BY team_id, problem_id, job_id",
        [eventId],
      )
    ).map(parseDeployment);
  }
}
