import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { digest, eventSchema, ID, KEY, scoreSchema, teamSchema } from "./cloud-records.js";
import type { CloudRepository, EventCreationReceipt } from "./cloud-repository.js";
import { deploymentSchema } from "./deployment-records.js";
import { NATIVE_COORDINATION_PROBLEM } from "./domain/coordination.js";
import { DeploymentConflict } from "./domain/deployment-work.js";
import type { DeploymentRecord } from "./domain/deployments.js";
import { CLOUD_EVENT_LIMITS, type EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import {
  type InstallationControl,
  type InstallationScope,
  installationControlKey,
  installationControlSchema,
  installationIntakeGuard,
  installationScopeDigest,
} from "./installation-control.js";

export function eventKey(eventId: string) {
  if (!ID.test(eventId)) throw new Error("Invalid event ID.");
  return { PK: `EVENT#${eventId}`, SK: "META" };
}
export function teamKey(eventId: string, teamId: string) {
  if (!ID.test(teamId)) throw new Error("Invalid team ID.");
  return { ...eventKey(eventId), SK: `TEAM#${teamId}` };
}
function accessKey(key: string) {
  if (!KEY.test(key)) throw new Error("Invalid team key.");
  return { PK: `ACCESS#${digest(key)}`, SK: "META" };
}
export function conflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TransactionConflictException") return true;
  if (error.name !== "TransactionCanceledException" || !("CancellationReasons" in error))
    return false;
  const reasons = z.array(z.object({ Code: z.string() })).safeParse(error.CancellationReasons);
  return (
    reasons.success &&
    reasons.data.some(
      (item) => item.Code === "ConditionalCheckFailed" || item.Code === "TransactionConflict",
    ) &&
    reasons.data.every((item) =>
      ["None", "ConditionalCheckFailed", "TransactionConflict"].includes(item.Code),
    )
  );
}
export interface CloudTableNames {
  readonly events: string;
  readonly teams: string;
  readonly deployments: string;
}
/** Surgical reuse of historical event/team transactions, with durable hash lookup and rotation CAS. */
export class DynamoCloudRepository implements CloudRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tables: CloudTableNames,
  ) {
    if (Object.values(tables).some((name) => !name))
      throw new Error("All cloud table names are required.");
  }
  private async transact(input: TransactWriteCommandInput): Promise<boolean> {
    try {
      await this.ddb.send(new TransactWriteCommand(input));
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }
  private async query(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(
        new QueryCommand({ ...input, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }),
      );
      items.push(...(page.Items ?? []));
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length > 0);
    return items;
  }
  async installationControl(): Promise<InstallationControl | undefined> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tables.events,
        Key: installationControlKey,
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return undefined;
    const control = installationControlSchema.parse(result.Item);
    if (control.scopeDigest !== installationScopeDigest(control.scope))
      throw new DeploymentConflict("installation_scope_corrupt");
    return control;
  }
  async assertAcceptingInstallation(): Promise<void> {
    if (await this.installationControl()) throw new DeploymentConflict("installation_draining");
  }
  /** Idempotent stop intent survives CLI interruption; no lease expiry can reopen intake. */
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
      await this.transact({
        TransactItems: [
          {
            Put: {
              TableName: this.tables.events,
              Item: { ...control, ...installationControlKey },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    )
      return control;
    const current = await this.installationControl();
    if (!current || current.scopeDigest !== scopeDigest)
      throw new DeploymentConflict("installation_stop_conflict");
    return current;
  }
  /** A GSI cannot prove that every event was drained. Intake must already be fenced. */
  async listStoppedInstallationEvents(scope: InstallationScope): Promise<EventRecord[]> {
    const control = await this.installationControl();
    if (!control || control.scopeDigest !== installationScopeDigest(scope))
      throw new DeploymentConflict("installation_not_stopped");
    const events: EventRecord[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(
        new ScanCommand({
          TableName: this.tables.events,
          ConsistentRead: true,
          FilterExpression: "begins_with(PK, :event) AND SK = :meta",
          ExpressionAttributeValues: { ":event": "EVENT#", ":meta": "META" },
          Limit: 100,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        const event = eventSchema.parse(item);
        if (item.PK !== eventKey(event.eventId).PK || item.SK !== "META")
          throw new DeploymentConflict("installation_event_scope_invalid");
        events.push(event);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length > 0);
    return events;
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
    // Archived events and their closed native HEADs are immutable. Validate all chunks,
    // not merely the event counters, before declaring retained data fully settled.
    for (const event of events) {
      if (!event.problems.some((problem) => problem.problemId === NATIVE_COORDINATION_PROBLEM))
        continue;
      const { DynamoDeploymentsCoordination } = await import(
        "./dynamodb-deployments-coordination.js"
      );
      await new DynamoDeploymentsCoordination(this.ddb, this.tables).closeFence(
        event.eventId,
        NATIVE_COORDINATION_PROBLEM,
      );
    }
    const control = await this.installationControl();
    if (!control || control.scopeDigest !== installationScopeDigest(scope))
      throw new DeploymentConflict("installation_scope_changed");
    if (control.status === "DRAINED") return;
    if (
      !(await this.transact({
        TransactItems: [
          {
            Update: {
              TableName: this.tables.events,
              Key: installationControlKey,
              UpdateExpression: "SET #status = :drained, updatedAt = :at",
              ConditionExpression: "scopeDigest = :scope AND #status = :closing",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":drained": "DRAINED",
                ":closing": "DRAINING",
                ":scope": control.scopeDigest,
                ":at": at,
              },
            },
          },
        ],
      }))
    )
      throw new DeploymentConflict("installation_drain_conflict");
  }
  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
    receipt?: EventCreationReceipt,
  ): Promise<"created" | "conflict"> {
    eventSchema.parse(event);
    // Event + intake fence + two rows per team, plus the optional replay receipt.
    if (
      teams.length === 0 ||
      teams.length > CLOUD_EVENT_LIMITS.maxTeams ||
      event.teamCount !== teams.length
    )
      throw new Error(`Event creation supports 1-${CLOUD_EVENT_LIMITS.maxTeams} teams.`);
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
    const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      installationIntakeGuard(this.tables.events),
      {
        Put: {
          TableName: this.tables.events,
          Item: {
            ...event,
            ...eventKey(event.eventId),
            GSI1PK: "INSTALLATION",
            GSI1SK: `${event.createdAt}#${event.eventId}`,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    for (const team of teams)
      writes.push(
        {
          Put: {
            TableName: this.tables.teams,
            Item: { ...team, ...teamKey(team.eventId, team.teamId) },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: this.tables.teams,
            Item: {
              ...accessKey(team.teamLoginKey),
              eventId: team.eventId,
              teamId: team.teamId,
              authVersion: team.authVersion,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      );
    if (receipt)
      writes.push({
        Put: {
          TableName: this.tables.events,
          Item: {
            PK: `CREATE#${digest(JSON.stringify([receipt.scope, receipt.key]))}`,
            SK: "META",
            requestHash: receipt.requestHash,
            response: receipt.response,
            eventId: event.eventId,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    if (await this.transact({ TransactItems: writes })) return "created";
    await this.assertAcceptingInstallation();
    return "conflict";
  }
  async replayEventCreation(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | undefined> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tables.events,
        Key: { PK: `CREATE#${digest(JSON.stringify([scope, key]))}`, SK: "META" },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return undefined;
    if (result.Item.requestHash !== requestHash)
      throw new DeploymentConflict("idempotency_key_reused");
    if (!result.Item.response) throw new Error("Corrupt event creation receipt.");
    return result.Item.response;
  }
  async getEvent(eventId: string): Promise<EventRecord | undefined> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tables.events,
        Key: eventKey(eventId),
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return undefined;
    const event = eventSchema.parse(result.Item);
    if (event.eventId !== eventId) throw new Error("Event scope mismatch.");
    return event;
  }
  async listEvents(): Promise<readonly EventRecord[]> {
    const items = await this.query({
      TableName: this.tables.events,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "INSTALLATION" },
      ScanIndexForward: false,
    });
    return items.map((item) => eventSchema.parse(item));
  }
  async getTeam(eventId: string, teamId: string): Promise<TeamRecord | undefined> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.tables.teams,
        Key: teamKey(eventId, teamId),
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return undefined;
    const team = teamSchema.parse(result.Item);
    if (team.eventId !== eventId || team.teamId !== teamId) throw new Error("Team scope mismatch.");
    return team;
  }
  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    const items = await this.query({
      TableName: this.tables.teams,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": eventKey(eventId).PK, ":prefix": "TEAM#" },
    });
    return items.map((item) => {
      const team = teamSchema.parse(item);
      if (team.eventId !== eventId) throw new Error("Team scope mismatch.");
      return team;
    });
  }
  async authenticateTeam(key: string, now: number): Promise<TeamRecord | undefined> {
    if (!KEY.test(key)) return undefined;
    const result = await this.ddb.send(
      new GetCommand({ TableName: this.tables.teams, Key: accessKey(key), ConsistentRead: true }),
    );
    if (!result.Item) return undefined;
    const access = z
      .object({
        eventId: z.string().regex(ID),
        teamId: z.string().regex(ID),
        authVersion: z.number().int().positive(),
      })
      .parse(result.Item);
    const team = await this.getTeam(access.eventId, access.teamId);
    if (
      !team ||
      team.accessRevoked ||
      team.authVersion !== access.authVersion ||
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
    const next = {
      ...team,
      teamLoginKey: replacementKey ?? team.teamLoginKey,
      authVersion: team.authVersion + 1,
      accessRevoked: replacementKey === undefined,
      updatedAt: at,
    };
    const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        Put: {
          TableName: this.tables.teams,
          Item: { ...next, ...teamKey(team.eventId, team.teamId) },
          ConditionExpression: "authVersion = :version",
          ExpressionAttributeValues: { ":version": team.authVersion },
        },
      },
      { Delete: { TableName: this.tables.teams, Key: accessKey(team.teamLoginKey) } },
    ];
    if (replacementKey)
      writes.push({
        Put: {
          TableName: this.tables.teams,
          Item: {
            ...accessKey(replacementKey),
            eventId: team.eventId,
            teamId: team.teamId,
            authVersion: next.authVersion,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    return (await this.transact({ TransactItems: writes })) ? "updated" : "conflict";
  }
  async listDeploymentsByTeam(
    eventId: string,
    teamId: string,
  ): Promise<readonly DeploymentRecord[]> {
    teamKey(eventId, teamId);
    const items = await this.query({
      TableName: this.tables.deployments,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :team)",
      ExpressionAttributeValues: {
        ":pk": eventKey(eventId).PK,
        ":team": `TEAM#${teamId}#PROBLEM#`,
      },
    });
    return items.map((item) => {
      const job = deploymentSchema.parse(item);
      if (job.eventId !== eventId || job.teamId !== teamId)
        throw new Error("Deployment team scope mismatch.");
      return job;
    });
  }
  async listTeamScores(eventId: string) {
    const items = await this.query({
      TableName: this.tables.teams,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": eventKey(eventId).PK, ":prefix": "SCORE#" },
    });
    return items.map((item) => {
      const score = scoreSchema.parse(item);
      if (score.eventId !== eventId) throw new Error("Score projection scope mismatch.");
      return score;
    });
  }
  async listDeploymentsByEvent(eventId: string): Promise<readonly DeploymentRecord[]> {
    const items = await this.query({
      TableName: this.tables.deployments,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": eventKey(eventId).PK },
    });
    return items.map((item) => {
      const deployment = deploymentSchema.parse(item);
      if (deployment.eventId !== eventId) throw new Error("Deployment scope mismatch.");
      return deployment;
    });
  }
}
