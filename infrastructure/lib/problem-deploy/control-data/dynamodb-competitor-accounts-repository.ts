import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { COMMERCIAL_REGION } from "../../cloud-hosting/regions.js";
import {
  connectionKey,
  connectionSchema,
  eventGuard,
  teamGuard,
  type Write,
} from "./deployment-storage.js";
import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
} from "./domain/competitor-accounts.js";
import { DeploymentConflict, type DeploymentConnection } from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { type CloudTableNames, conflict, eventKey } from "./dynamodb-cloud-repository.js";
import { installationIntakeGuard } from "./installation-control.js";

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const accountId = z.string().regex(/^\d{12}$/u);
const recordSchema = z.object({
  awsAccountId: accountId,
  region: z.string().regex(COMMERCIAL_REGION),
  competitorRoleName: z.string().regex(/^[A-Za-z0-9_+=,.@-]{1,64}$/u),
  alias: z.string().min(1).max(120).optional(),
  verified: z.boolean(),
  verifiedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().min(1),
  registrationId: id,
  revision: z.number().int().positive(),
});
const externalIdKey = { PK: "INSTALLATION#ACCOUNTS", SK: "EXTERNAL_ID" };
function accountKey(value: string) {
  return { PK: "INSTALLATION#ACCOUNTS", SK: `ACCOUNT#${accountId.parse(value)}` };
}
function referenceKey(value: string, eventId: string, teamId: string) {
  return {
    PK: `COMPETITOR#${accountId.parse(value)}`,
    SK: `EVENT#${id.parse(eventId)}#TEAM#${id.parse(teamId)}`,
  };
}
const referenceSchema = z.object({
  awsAccountId: accountId,
  eventId: id,
  teamId: id,
  registrationId: id,
});
function parseRecord(row: Record<string, unknown>): CompetitorAccountRecord {
  const record = recordSchema.parse(row);
  const key = accountKey(record.awsAccountId);
  if (row.PK !== key.PK || row.SK !== key.SK)
    throw new Error("Competitor registry scope mismatch.");
  if (record.verified && !record.verifiedAt) throw new Error("Missing competitor verification.");
  return record;
}
function revisionValues(record: CompetitorAccountRecord) {
  return { ":registration": record.registrationId, ":revision": record.revision };
}
function conditionalConflict(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "ConditionalCheckFailedException") || conflict(error)
  );
}
function throwIfIntakeClosed(error: unknown): void {
  if (!conflict(error)) return;
  const parsed = z
    .object({ CancellationReasons: z.array(z.object({ Code: z.string() })) })
    .safeParse(error);
  if (parsed.success && parsed.data.CancellationReasons[0]?.Code === "ConditionalCheckFailed")
    throw new DeploymentConflict("installation_draining");
}
const revisionCondition = "registrationId = :registration AND revision = :revision";

/** Reuses the historical conditional account adapter on the existing installation Events table. */
export class DynamoDbCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly tables: CloudTableNames,
  ) {}
  /** Missing key material may be initialized only before this registry has ever used it. */
  async reserveExternalIdInitialization(parameterArn: string): Promise<boolean> {
    if (await this.read(externalIdKey)) return false;
    if ((await this.query("INSTALLATION#ACCOUNTS", "ACCOUNT#")).length) return false;
    if (await this.hasSecretReferences(parameterArn)) return false;
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            installationIntakeGuard(this.tables.events),
            {
              Put: {
                TableName: this.tables.events,
                Item: { ...externalIdKey, parameterArn, state: "INITIALIZING" },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      throwIfIntakeClosed(error);
      if (conditionalConflict(error)) return false;
      throw error;
    }
  }
  /** Retained even after every account is removed, so a missing key cannot silently reset old trust. */
  async observeExternalId(parameterArn: string): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.tables.events,
        Item: { ...externalIdKey, parameterArn, state: "INITIALIZED" },
        ConditionExpression:
          "attribute_not_exists(PK) OR (parameterArn = :parameter AND #state IN (:initializing, :initialized))",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":parameter": parameterArn,
          ":initializing": "INITIALIZING",
          ":initialized": "INITIALIZED",
        },
      }),
    );
  }
  private async hasSecretReferences(parameterArn: string): Promise<boolean> {
    for (const table of [this.tables.events, this.tables.deployments]) {
      let cursor: Record<string, unknown> | undefined;
      do {
        const output = await this.ddb.send(
          new ScanCommand({
            TableName: table,
            ConsistentRead: true,
            Select: "COUNT",
            Limit: 100,
            ExclusiveStartKey: cursor,
            FilterExpression:
              "begins_with(PK, :references) OR externalIdParameter = :parameter OR #connection.externalIdParameter = :parameter",
            ExpressionAttributeNames: { "#connection": "connection" },
            ExpressionAttributeValues: { ":references": "COMPETITOR#", ":parameter": parameterArn },
          }),
        );
        const page = z
          .object({
            Count: z.number().int().nonnegative(),
            LastEvaluatedKey: z.record(z.unknown()).optional(),
          })
          .parse(output);
        if (page.Count > 0) return true;
        cursor = page.LastEvaluatedKey;
      } while (cursor && Object.keys(cursor).length > 0);
    }
    return false;
  }
  async listAccounts(): Promise<readonly CompetitorAccountRecord[]> {
    const rows = await this.query("INSTALLATION#ACCOUNTS", "ACCOUNT#");
    return rows.map(parseRecord);
  }
  async getAccount(value: string): Promise<CompetitorAccountRecord | undefined> {
    const row = await this.read(accountKey(value));
    if (!row) return undefined;
    const record = parseRecord(row);
    if (record.awsAccountId !== value) throw new Error("Competitor registry scope mismatch.");
    return record;
  }
  async createAccount(input: CompetitorAccountRecord): Promise<"created" | "conflict"> {
    const record = recordSchema.parse(input);
    if (record.verified || record.verifiedAt || record.revision !== 1)
      throw new Error("New competitor registrations must be unverified.");
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            installationIntakeGuard(this.tables.events),
            {
              ConditionCheck: {
                TableName: this.tables.events,
                Key: externalIdKey,
                ConditionExpression: "#state = :ready",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: { ":ready": "INITIALIZED" },
              },
            },
            {
              Put: {
                TableName: this.tables.events,
                Item: { ...record, ...accountKey(record.awsAccountId) },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return "created";
    } catch (error) {
      throwIfIntakeClosed(error);
      if (conditionalConflict(error)) return "conflict";
      throw error;
    }
  }
  async setVerified(record: CompetitorAccountRecord, verified: boolean, at: string) {
    recordSchema.parse(record);
    z.string().datetime().parse(at);
    try {
      const result = await this.ddb.send(
        new UpdateCommand({
          TableName: this.tables.events,
          Key: accountKey(record.awsAccountId),
          UpdateExpression: verified
            ? "SET verified = :verified, verifiedAt = :at, updatedAt = :at, revision = :next"
            : "SET verified = :verified, updatedAt = :at, revision = :next REMOVE verifiedAt",
          ConditionExpression: revisionCondition,
          ExpressionAttributeValues: {
            ...revisionValues(record),
            ":verified": verified,
            ":at": at,
            ":next": record.revision + 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      if (!result.Attributes) throw new Error("Missing competitor verification result.");
      return parseRecord(result.Attributes);
    } catch (error) {
      if (conditionalConflict(error)) return undefined;
      throw error;
    }
  }
  async deleteAccount(record: CompetitorAccountRecord): Promise<"deleted" | "in_use" | "conflict"> {
    recordSchema.parse(record);
    const references = await this.query(`COMPETITOR#${record.awsAccountId}`, "EVENT#");
    const checked = new Set<string>();
    for (const row of references) {
      const reference = referenceSchema.parse(row);
      const key = referenceKey(reference.awsAccountId, reference.eventId, reference.teamId);
      if (reference.awsAccountId !== record.awsAccountId || row.PK !== key.PK || row.SK !== key.SK)
        throw new Error("Competitor reference scope mismatch.");
      if (checked.has(reference.eventId)) continue;
      checked.add(reference.eventId);
      const event = await this.read(eventKey(reference.eventId));
      // ARCHIVED is terminal. Missing/legacy/incomplete teardown is never evidence of no resources.
      if (
        event?.eventId !== reference.eventId ||
        event.status !== "ARCHIVED" ||
        !Number.isSafeInteger(event.teardownExpected) ||
        Number(event.teardownExpected) < 0 ||
        event.teardownExpected !== event.teardownCompleted
      )
        return "in_use";
    }
    try {
      await this.ddb.send(
        new DeleteCommand({
          TableName: this.tables.events,
          Key: accountKey(record.awsAccountId),
          ConditionExpression: revisionCondition,
          ExpressionAttributeValues: revisionValues(record),
        }),
      );
      return "deleted";
    } catch (error) {
      if (conditionalConflict(error)) return "conflict";
      throw error;
    }
  }
  /** Link the existing connection and its deletion fence atomically; no account-sharing rule is inferred. */
  async saveConnection(input: {
    readonly record: CompetitorAccountRecord;
    readonly event: EventRecord;
    readonly team: TeamRecord;
    readonly connection: DeploymentConnection;
    readonly previousVersion?: number;
    readonly now: number;
  }): Promise<"saved" | "conflict"> {
    const { record, event, team, connection, previousVersion, now } = input;
    recordSchema.parse(record);
    connectionSchema.parse(connection);
    if (
      !record.verified ||
      event.eventId !== team.eventId ||
      connection.eventId !== event.eventId ||
      connection.teamId !== team.teamId ||
      connection.accountId !== record.awsAccountId ||
      (team.awsAccountId !== undefined && team.awsAccountId !== record.awsAccountId) ||
      (team.region !== undefined && team.region !== record.region) ||
      connection.region !== record.region ||
      connection.roleArn !==
        `arn:aws:iam::${record.awsAccountId}:role/${record.competitorRoleName}` ||
      connection.bindingId !== `account-${record.registrationId.toLowerCase()}` ||
      connection.registrationId !== record.registrationId ||
      connection.version !== (previousVersion ?? 0) + 1
    )
      throw new Error("Competitor connection scope mismatch.");
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            installationIntakeGuard(this.tables.events),
            eventGuard(this.tables.events, event, now),
            teamGuard(this.tables.teams, team, now),
            {
              Update: {
                TableName: this.tables.events,
                Key: accountKey(record.awsAccountId),
                UpdateExpression: "SET revision = :next",
                ConditionExpression: `${revisionCondition} AND verified = :yes`,
                ExpressionAttributeValues: {
                  ...revisionValues(record),
                  ":yes": true,
                  ":next": record.revision + 1,
                },
              },
            },
            {
              Put: {
                TableName: this.tables.events,
                Item: {
                  ...referenceKey(record.awsAccountId, event.eventId, team.teamId),
                  awsAccountId: record.awsAccountId,
                  eventId: event.eventId,
                  teamId: team.teamId,
                  registrationId: record.registrationId,
                },
              },
            },
            {
              Put: {
                TableName: this.tables.events,
                Item: { ...connection, ...connectionKey(event.eventId, team.teamId) },
                ConditionExpression:
                  previousVersion === undefined
                    ? "attribute_not_exists(PK)"
                    : "version = :previous",
                ...(previousVersion === undefined
                  ? {}
                  : { ExpressionAttributeValues: { ":previous": previousVersion } }),
              },
            },
          ],
        }),
      );
      return "saved";
    } catch (error) {
      throwIfIntakeClosed(error);
      if (conditionalConflict(error)) return "conflict";
      throw error;
    }
  }
  private async read(key: Record<string, string>) {
    return (
      await this.ddb.send(
        new GetCommand({ TableName: this.tables.events, Key: key, ConsistentRead: true }),
      )
    ).Item;
  }
  private async query(pk: string, prefix: string) {
    const rows: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.ddb.send(
        new QueryCommand({
          TableName: this.tables.events,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      rows.push(...(page.Items ?? []));
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length > 0);
    return rows;
  }
}

/** Optional only for the previously shipped exact-binding records; registry jobs always get an atomic current-row guard. */
export async function registeredAccountGuard(
  ddb: DynamoDBDocumentClient,
  tables: CloudTableNames,
  connection: DeploymentConnection,
): Promise<Write | undefined> {
  if (connection.registrationId === undefined) return undefined;
  const record = await new DynamoDbCompetitorAccountsRepository(ddb, tables).getAccount(
    connection.accountId,
  );
  if (
    !record?.verified ||
    connection.bindingId !== `account-${record.registrationId.toLowerCase()}` ||
    connection.registrationId !== record.registrationId ||
    connection.region !== record.region ||
    connection.roleArn !== `arn:aws:iam::${record.awsAccountId}:role/${record.competitorRoleName}`
  )
    throw new DeploymentConflict("competitor_account_changed");
  return {
    ConditionCheck: {
      TableName: tables.events,
      Key: accountKey(record.awsAccountId),
      ConditionExpression: `${revisionCondition} AND verified = :yes`,
      ExpressionAttributeValues: { ...revisionValues(record), ":yes": true },
    },
  };
}
