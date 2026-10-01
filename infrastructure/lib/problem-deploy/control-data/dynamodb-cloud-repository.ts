import { createHash } from "node:crypto";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { CloudRepository, EventCreationReceipt } from "./cloud-repository.js";
import { DeploymentConflict } from "./domain/deployment-work.js";
import type { DeploymentRecord } from "./domain/deployments.js";
import { CLOUD_EVENT_LIMITS, type EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";

const scoreSchema = z.object({
  eventId: z.string(),
  teamId: z.string(),
  score: z.number().finite(),
  completedProblems: z.number().int().nonnegative(),
});
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const digest = (key: string): string => createHash("sha256").update(key).digest("hex");
const teamSchema = z.object({
  eventId: z.string().regex(ID),
  teamId: z.string().regex(ID),
  internalSlug: z.string(),
  displayName: z.string().optional(),
  awsAccountId: z.string().optional(),
  region: z.string().optional(),
  teamLoginKey: z.string().regex(KEY),
  authVersion: z.number().int().positive(),
  accessRevoked: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.number().finite(),
});
const eventSchema = z.object({
  eventId: z.string().regex(ID),
  name: z.string(),
  status: z.enum(["DRAFT", "DEPLOYING", "READY", "ENDED", "TEARDOWN", "ARCHIVED"]),
  problems: z.array(
    z.object({
      problemId: z.string(),
      defaultRegion: z.string(),
      defaultAwsAccountId: z.string().optional(),
    }),
  ),
  teamCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.number().finite(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  scoringLocked: z.boolean().optional(),
  scoreboardFreezeMinutes: z.number().optional(),
});
export const deploymentSchema = z.object({
  jobId: z.string().regex(ID),
  eventId: z.string().regex(ID),
  teamId: z.string().regex(ID),
  problemId: z.string(),
  region: z.string(),
  awsAccountId: z.string(),
  status: z.enum([
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "FAILED",
    "DELETING",
    "DELETED",
    "EXPIRED",
    "AUTO_DELETED",
  ]),
  expiresAt: z.number().finite(),
  score: z.number().finite(),
  publicOutputs: z.record(z.string()).optional(),
  scoring: z.object({ kind: z.literal("flag"), points: z.number() }).optional(),
  flagSubmitted: z.boolean().optional(),
  failureReason: z.string().optional(),
  createdAt: z.string().optional(),
});
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
  async createEventWithTeams(
    event: EventRecord,
    teams: readonly TeamRecord[],
    receipt?: EventCreationReceipt,
  ): Promise<"created" | "conflict"> {
    eventSchema.parse(event);
    // One event + one metadata and one hash lookup row per team. 25 teams use 51 writes.
    if (
      teams.length === 0 ||
      teams.length > CLOUD_EVENT_LIMITS.maxTeams ||
      event.teamCount !== teams.length
    )
      throw new Error("Event creation supports 1-49 teams.");
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
    return (await this.transact({ TransactItems: writes })) ? "created" : "conflict";
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
