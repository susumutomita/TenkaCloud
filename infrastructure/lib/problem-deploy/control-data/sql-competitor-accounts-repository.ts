import { z } from "zod";
import { COMMERCIAL_REGION } from "../../cloud-hosting/regions.js";
import { connectionSchema } from "./deployment-work-records.js";
import type {
  CompetitorAccountRecord,
  CompetitorAccountsRepository,
} from "./domain/competitor-accounts.js";
import { DeploymentConflict, type DeploymentConnection } from "./domain/deployment-work.js";
import type { EventRecord } from "./domain/events.js";
import type { TeamRecord } from "./domain/teams.js";
import { sqlPayload } from "./sql-cloud-records.js";
import { sqlEventGuard, sqlTeamGuard } from "./sql-deployment-guards.js";
import type { SqlExecutor, SqlRow, SqlStatement } from "./sql-port.js";
import { sqlChangesGuard, sqlCommit, sqlGuard, sqlIntakeGuard } from "./sql-transaction.js";

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
const referenceSchema = z.object({
  awsAccountId: accountId,
  eventId: id,
  teamId: id,
  registrationId: id,
});
function parseRecord(row: SqlRow): CompetitorAccountRecord {
  const record = recordSchema.parse(sqlPayload(row));
  if (row.account_id !== record.awsAccountId)
    throw new Error("Competitor registry scope mismatch.");
  if (record.verified && !record.verifiedAt) throw new Error("Missing competitor verification.");
  return record;
}
const revisionCondition =
  "account_id = ? AND json_extract(payload, '$.registrationId') = ? AND json_extract(payload, '$.revision') = ?";
function revisionValues(record: CompetitorAccountRecord) {
  return [record.awsAccountId, record.registrationId, record.revision];
}

/** All durable locations equivalent to the Dynamo event/deployment secret-reference scan. */
function unusedExternalId(parameterArn: string) {
  const tables = [
    "cloud_events",
    "cloud_connections",
    "cloud_deployments",
    "cloud_deployment_attempts",
  ];
  return {
    predicate:
      "NOT EXISTS (SELECT 1 FROM cloud_external_id)" +
      " AND NOT EXISTS (SELECT 1 FROM cloud_competitor_accounts)" +
      " AND NOT EXISTS (SELECT 1 FROM cloud_competitor_references)" +
      tables
        .map(
          (table) =>
            ` AND NOT EXISTS (SELECT 1 FROM ${table} WHERE json_extract(payload, '$.externalIdParameter') = ? OR json_extract(payload, '$.connection.externalIdParameter') = ?)`,
        )
        .join(""),
    params: tables.flatMap(() => [parameterArn, parameterArn]),
  };
}

/** Native SQLite/libSQL adapter for the canonical installation account methods. */
export class SqlCompetitorAccountsRepository implements CompetitorAccountsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  private async acceptingCommit(statements: readonly SqlStatement[]): Promise<boolean> {
    if (await sqlCommit(this.sql, [sqlIntakeGuard(), ...statements])) return true;
    if (await this.sql.get("SELECT id FROM cloud_installation_control WHERE id = 1"))
      throw new DeploymentConflict("installation_draining");
    return false;
  }

  /** Reservation and all history checks share one transaction, including concurrent first use. */
  async reserveExternalIdInitialization(parameterArn: string): Promise<boolean> {
    const unused = unusedExternalId(parameterArn);
    // Preserve the canonical used-store result even when the installation is draining.
    if (await this.sql.get(`SELECT 1 WHERE NOT (${unused.predicate})`, unused.params)) return false;
    return this.acceptingCommit([
      sqlGuard(unused.predicate, unused.params),
      {
        sql: "INSERT INTO cloud_external_id (id, payload) VALUES (1, ?)",
        params: [JSON.stringify({ parameterArn, state: "INITIALIZING" })],
      },
    ]);
  }

  /** This use fence outlives ordinary account removal; only the installation reset clears it. */
  async observeExternalId(parameterArn: string): Promise<void> {
    const saved = await sqlCommit(this.sql, [
      {
        sql: `INSERT INTO cloud_external_id (id, payload) VALUES (1, ?)
          ON CONFLICT (id) DO UPDATE SET payload = excluded.payload
          WHERE json_extract(cloud_external_id.payload, '$.parameterArn') = ?
            AND json_extract(cloud_external_id.payload, '$.state') IN ('INITIALIZING', 'INITIALIZED')`,
        params: [JSON.stringify({ parameterArn, state: "INITIALIZED" }), parameterArn],
      },
      sqlChangesGuard(),
    ]);
    if (!saved) throw new DeploymentConflict("external_id_changed");
  }

  async listAccounts(): Promise<readonly CompetitorAccountRecord[]> {
    return (
      await this.sql.all(
        "SELECT account_id, payload FROM cloud_competitor_accounts ORDER BY account_id",
      )
    ).map(parseRecord);
  }

  async getAccount(value: string): Promise<CompetitorAccountRecord | undefined> {
    const row = await this.sql.get(
      "SELECT account_id, payload FROM cloud_competitor_accounts WHERE account_id = ?",
      [accountId.parse(value)],
    );
    return row ? parseRecord(row) : undefined;
  }

  async createAccount(input: CompetitorAccountRecord): Promise<"created" | "conflict"> {
    const record = recordSchema.parse(input);
    if (record.verified || record.verifiedAt || record.revision !== 1)
      throw new Error("New competitor registrations must be unverified.");
    return (await this.acceptingCommit([
      sqlGuard(
        "EXISTS (SELECT 1 FROM cloud_external_id WHERE id = 1 AND json_extract(payload, '$.state') = 'INITIALIZED')",
      ),
      {
        sql: "INSERT INTO cloud_competitor_accounts (account_id, payload) VALUES (?, ?)",
        params: [record.awsAccountId, JSON.stringify(record)],
      },
    ]))
      ? "created"
      : "conflict";
  }

  async setVerified(record: CompetitorAccountRecord, verified: boolean, at: string) {
    recordSchema.parse(record);
    z.string().datetime().parse(at);
    const mutation = verified
      ? "json_set(payload, '$.verified', json('true'), '$.verifiedAt', ?, '$.updatedAt', ?, '$.revision', ?)"
      : "json_remove(json_set(payload, '$.verified', json('false'), '$.updatedAt', ?, '$.revision', ?), '$.verifiedAt')";
    const rows = await this.sql.all(
      `UPDATE cloud_competitor_accounts SET payload = ${mutation} WHERE ${revisionCondition} RETURNING account_id, payload`,
      [...(verified ? [at, at] : [at]), record.revision + 1, ...revisionValues(record)],
    );
    return rows[0] ? parseRecord(rows[0]) : undefined;
  }

  async deleteAccount(record: CompetitorAccountRecord): Promise<"deleted" | "in_use" | "conflict"> {
    recordSchema.parse(record);
    const references = await this.sql.all(
      "SELECT account_id, event_id, team_id, payload FROM cloud_competitor_references WHERE account_id = ?",
      [record.awsAccountId],
    );
    const checked = new Set<string>();
    for (const row of references) {
      const reference = referenceSchema.parse(sqlPayload(row));
      if (
        reference.awsAccountId !== record.awsAccountId ||
        row.account_id !== reference.awsAccountId ||
        row.event_id !== reference.eventId ||
        row.team_id !== reference.teamId
      )
        throw new Error("Competitor reference scope mismatch.");
      if (checked.has(reference.eventId)) continue;
      checked.add(reference.eventId);
      const eventRow = await this.sql.get("SELECT payload FROM cloud_events WHERE event_id = ?", [
        reference.eventId,
      ]);
      const event = eventRow ? z.record(z.unknown()).parse(sqlPayload(eventRow)) : undefined;
      // ARCHIVED is terminal; absent/incomplete teardown is never evidence of no resources.
      if (
        event?.eventId !== reference.eventId ||
        event.status !== "ARCHIVED" ||
        !Number.isSafeInteger(event.teardownExpected) ||
        Number(event.teardownExpected) < 0 ||
        event.teardownExpected !== event.teardownCompleted
      )
        return "in_use";
    }
    const result = await this.sql.run(
      `DELETE FROM cloud_competitor_accounts WHERE ${revisionCondition}`,
      revisionValues(record),
    );
    return Number(result.changes) === 1 ? "deleted" : "conflict";
  }

  /** Account revision, deletion reference, and connection version advance atomically. */
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
      (team.region !== undefined && team.region !== connection.region) ||
      (team.region === undefined &&
        event.problems.some((problem) => problem.defaultRegion !== connection.region)) ||
      connection.roleArn !==
        `arn:aws:iam::${record.awsAccountId}:role/${record.competitorRoleName}` ||
      connection.bindingId !== `account-${record.registrationId.toLowerCase()}` ||
      connection.registrationId !== record.registrationId ||
      connection.version !== (previousVersion ?? 0) + 1
    )
      throw new Error("Competitor connection scope mismatch.");
    const writes: SqlStatement[] = [
      sqlEventGuard(event, now),
      sqlTeamGuard(team, now),
      {
        sql: `UPDATE cloud_competitor_accounts SET payload = json_set(payload, '$.revision', ?)
          WHERE ${revisionCondition} AND json_type(payload, '$.verified') = 'true'`,
        params: [record.revision + 1, ...revisionValues(record)],
      },
      sqlChangesGuard(),
      {
        sql: `INSERT INTO cloud_competitor_references (account_id, event_id, team_id, payload) VALUES (?, ?, ?, ?)
          ON CONFLICT (account_id, event_id, team_id) DO UPDATE SET payload = excluded.payload`,
        params: [
          record.awsAccountId,
          event.eventId,
          team.teamId,
          JSON.stringify({
            awsAccountId: record.awsAccountId,
            eventId: event.eventId,
            teamId: team.teamId,
            registrationId: record.registrationId,
          }),
        ],
      },
    ];
    writes.push(
      previousVersion === undefined
        ? {
            sql: "INSERT INTO cloud_connections (event_id, team_id, payload) VALUES (?, ?, ?)",
            params: [event.eventId, team.teamId, JSON.stringify(connection)],
          }
        : {
            sql: `UPDATE cloud_connections SET payload = ? WHERE event_id = ? AND team_id = ?
              AND json_extract(payload, '$.version') = ?`,
            params: [JSON.stringify(connection), event.eventId, team.teamId, previousVersion],
          },
      sqlChangesGuard(),
    );
    return (await this.acceptingCommit(writes)) ? "saved" : "conflict";
  }
}

/** Legacy exact bindings are optional; registry connections must guard the current verified row. */
export async function sqlRegisteredAccountGuard(
  sql: SqlExecutor,
  connection: DeploymentConnection,
): Promise<SqlStatement | undefined> {
  if (connection.registrationId === undefined) return undefined;
  connectionSchema.parse(connection);
  const record = await new SqlCompetitorAccountsRepository(sql).getAccount(connection.accountId);
  if (
    !record?.verified ||
    connection.bindingId !== `account-${record.registrationId.toLowerCase()}` ||
    connection.registrationId !== record.registrationId ||
    connection.roleArn !== `arn:aws:iam::${record.awsAccountId}:role/${record.competitorRoleName}`
  )
    throw new DeploymentConflict("competitor_account_changed");
  return sqlGuard(
    `EXISTS (SELECT 1 FROM cloud_competitor_accounts WHERE ${revisionCondition} AND json_type(payload, '$.verified') = 'true')`,
    revisionValues(record),
  );
}
