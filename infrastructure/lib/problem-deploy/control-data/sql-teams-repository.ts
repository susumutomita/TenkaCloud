import { createHash } from "node:crypto";
import type {
  SqlExecutor,
  SqlParam,
  TeamDeploymentRecord,
  TeamLoginKeyRotationInput,
  TeamLoginKeyRotationOutcome,
  TeamRecord,
  TeamsRepository,
} from "./types.js";

export const TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID = "2026-07-04-team-login-key-payload-scrub";
export const TEAM_LOGIN_KEY_SCRUB_SQL =
  "UPDATE teams SET payload = json_remove(payload, '$.teamLoginKey') " +
  "WHERE json_type(payload, '$.teamLoginKey') IS NOT NULL " +
  `AND NOT EXISTS (
    SELECT 1 FROM control_data_migrations
    WHERE migration_id = '${TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID}'
  )`;

/**
 * [ADR-049 §5.1 / §5.2] SQLite implementation of {@link TeamsRepository}. One SQL
 * layer in the SQLite dialect covers both Turso (libSQL) and Cloudflare D1;
 * switching hosts is a driver swap, not a rewrite. It talks to an injected
 * {@link SqlExecutor} so it carries no client dependency of its own — `node:sqlite`
 * backs it in tests, a future `@libsql/client` adapter backs it in production.
 *
 * Schema: the full record is stored as a JSON `payload` so new team attributes
 * round-trip without a migration, with denormalized columns for the query paths
 * that must be indexable (tenant filtering, participant-login lookup, TTL prune)
 * rather than JSON-scanned.
 *
 * **[Issue #2290]** The participant bearer (`teamLoginKey`) is indexed only as a
 * SHA-256 **hash** in `login_key_hash` — the plaintext key never lands in an index
 * column. DynamoDB's GSI2 stores `TEAMKEY#<plaintext>`; the SQLite backend stores
 * `sha256(key)`. Both are looked up by the same plaintext key
 * ({@link SqlTeamsRepository.getTeamByLoginKey}) and return the same team.
 */
export const TEAMS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS teams (
  event_id       TEXT    NOT NULL,
  team_id        TEXT    NOT NULL,
  tenant_id      TEXT    NOT NULL,
  login_key_hash TEXT,
  expires_at     INTEGER NOT NULL,
  payload        TEXT    NOT NULL,
  PRIMARY KEY (event_id, team_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_tenant
  ON teams (tenant_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_login_key_hash
  ON teams (login_key_hash) WHERE login_key_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS control_data_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL
)`,
  TEAM_LOGIN_KEY_SCRUB_SQL,
  `INSERT OR IGNORE INTO control_data_migrations (migration_id, applied_at)
  VALUES ('${TEAM_LOGIN_KEY_SCRUB_MIGRATION_ID}', datetime('now'))`,
] as const;

/** SQL script form retained for local SQLite parity tests and manual bootstrap. */
export const TEAMS_SCHEMA_SQL = `${TEAMS_SCHEMA_STATEMENTS.join(";\n")};`;

/**
 * [Issue #2290] SHA-256 hash of a participant `teamLoginKey`, hex-encoded (64
 * chars). Deterministic so the same plaintext key always resolves to the same
 * indexed row. `node:crypto` is a Node built-in — this seam adds no dependency.
 */
export function hashLoginKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * JSON payload with the plaintext bearer stripped ([Issue #2290] the login key
 * never lands in the payload column).
 */
function teamPayloadWithoutLoginKey(record: TeamRecord): string {
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = record;
  return JSON.stringify(safeRecord);
}

/**
 * [#2437] Column list + positional params for inserting one team row. Shared by
 * {@link SqlTeamsRepository.putTeam} and
 * `SqlEventsRepository.createEventWithTeams` so the atomic event+teams
 * transaction marshals rows exactly like this repository's own writes
 * (sparse `login_key_hash`, login-key-scrubbed payload).
 */
export const TEAM_INSERT_SQL =
  "INSERT INTO teams (event_id, team_id, tenant_id, login_key_hash, expires_at, payload) " +
  "VALUES (?, ?, ?, ?, ?, ?)";

/** Positional params matching {@link TEAM_INSERT_SQL}. */
export function teamRowParams(record: TeamRecord): SqlParam[] {
  // sparse index parity: empty teamLoginKey stores NULL so it stays out of the
  // login-key index (matches DDB's sparse GSI2).
  return [
    record.eventId,
    record.teamId,
    record.tenantId,
    record.teamLoginKey ? hashLoginKey(record.teamLoginKey) : null,
    record.expiresAt,
    teamPayloadWithoutLoginKey(record),
  ];
}

function recordWithoutStoredLoginKey(payload: unknown): TeamRecord {
  const parsed = JSON.parse(String(payload)) as TeamRecord;
  const { teamLoginKey: _teamLoginKey, ...safeRecord } = parsed;
  return safeRecord;
}

export class SqlTeamsRepository implements TeamsRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async getTeam(
    tenantId: string,
    eventId: string,
    teamId: string,
  ): Promise<TeamRecord | undefined> {
    const row = await this.sql.get(
      "SELECT tenant_id, payload FROM teams WHERE event_id = ? AND team_id = ?",
      [eventId, teamId],
    );
    // Same guard as the DDB backend: absent row or tenant mismatch → undefined.
    if (!row || row.tenant_id !== tenantId) return undefined;
    return recordWithoutStoredLoginKey(row.payload);
  }

  async getTeamByLoginKey(loginKey: string): Promise<TeamRecord | undefined> {
    // Hash the incoming plaintext key and match the indexed hash column — the
    // plaintext bearer never touches an index (mirror of DDB GSI2 `TEAMKEY#<key>`).
    const row = await this.sql.get("SELECT payload FROM teams WHERE login_key_hash = ?", [
      hashLoginKey(loginKey),
    ]);
    if (!row) return undefined;
    return {
      ...recordWithoutStoredLoginKey(row.payload),
      // The caller already presented this bearer. Restore it in memory only;
      // it is never loaded from or persisted to SQL.
      teamLoginKey: loginKey,
    };
  }

  async listTeamsByEvent(eventId: string): Promise<readonly TeamRecord[]> {
    const rows = await this.sql.all(
      // team_id 昇順で DDB base-table (SK 昇順) と決定的に揃える。
      "SELECT payload FROM teams WHERE event_id = ? ORDER BY team_id ASC",
      [eventId],
    );
    return rows.map((row) => recordWithoutStoredLoginKey(row.payload));
  }

  async listTeamsForDeployment(eventId: string): Promise<readonly TeamDeploymentRecord[]> {
    const rows = await this.sql.all(
      "SELECT payload, login_key_hash FROM teams WHERE event_id = ? ORDER BY team_id ASC",
      [eventId],
    );
    return rows.map((row) => {
      const team = recordWithoutStoredLoginKey(row.payload);
      const loginKeyHash = row.login_key_hash;
      if (typeof loginKeyHash !== "string" || !/^[0-9a-f]{64}$/.test(loginKeyHash)) {
        throw new Error(
          `team ${team.teamId} in event ${eventId} has no participant login credential`,
        );
      }
      return { ...team, credential: { kind: "sha256", value: loginKeyHash } };
    });
  }

  async rotateLoginKey(input: TeamLoginKeyRotationInput): Promise<TeamLoginKeyRotationOutcome> {
    const loginKeyHash = hashLoginKey(input.newLoginKey);
    // libSQL batch is atomic, but UPDATE does not fail when its predicate matches zero rows.
    // The deliberately invalid INSERT turns any non-exact match into a constraint error so
    // a concurrent delete cannot partially rotate the Team and its Deployment indexes.
    const assertPreviousUpdateMatchedExactlyOneRow = {
      sql:
        "INSERT INTO control_data_migrations (migration_id, applied_at) " +
        "SELECT 'login-key-rotation-assertion', NULL WHERE changes() <> 1",
    };
    const statements = [
      {
        sql:
          "UPDATE teams SET login_key_hash = ?, payload = json_set(payload, '$.updatedAt', ?) " +
          "WHERE tenant_id = ? AND event_id = ? AND team_id = ? " +
          "AND json_extract(payload, '$.updatedAt') = ?",
        params: [
          loginKeyHash,
          input.updatedAt,
          input.tenantId,
          input.eventId,
          input.teamId,
          input.expectedUpdatedAt,
        ],
      },
      assertPreviousUpdateMatchedExactlyOneRow,
      ...input.deployments.flatMap((deployment) => [
        {
          sql:
            "UPDATE deployments SET login_key_hash = ?, updated_at = ?, " +
            "payload = json_set(json_remove(payload, '$.teamLoginKey', '$.teamLoginKeyHash'), '$.updatedAt', ?) " +
            "WHERE list_tenant_id = ? AND event_id = ? AND team_id = ? AND job_id = ?",
          params: [
            loginKeyHash,
            input.updatedAt,
            input.updatedAt,
            input.tenantId,
            input.eventId,
            input.teamId,
            deployment.jobId,
          ],
        },
        assertPreviousUpdateMatchedExactlyOneRow,
      ]),
    ];
    try {
      await this.sql.batch(statements);
      return { outcome: "updated" };
    } catch (error) {
      if (isLoginKeyRotationConflict(error)) return { outcome: "conflict" };
      throw error;
    }
  }

  async putTeam(record: TeamRecord): Promise<void> {
    await this.sql.run(
      `${TEAM_INSERT_SQL} ` +
        "ON CONFLICT(event_id, team_id) DO UPDATE SET " +
        "tenant_id = excluded.tenant_id, login_key_hash = excluded.login_key_hash, " +
        "expires_at = excluded.expires_at, payload = excluded.payload",
      teamRowParams(record),
    );
  }

  async deleteTeam(eventId: string, teamId: string): Promise<void> {
    await this.sql.run("DELETE FROM teams WHERE event_id = ? AND team_id = ?", [eventId, teamId]);
  }

  async pruneExpired(nowEpochSeconds: number): Promise<number> {
    const result = await this.sql.run(
      "DELETE FROM teams WHERE expires_at > 0 AND expires_at <= ?",
      [nowEpochSeconds],
    );
    return Number(result.changes);
  }
}

function isLoginKeyRotationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, extendedCode } = error as { code?: unknown; extendedCode?: unknown };
  if (
    [code, extendedCode].some((value) =>
      [
        "SQLITE_CONSTRAINT_NOTNULL",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
        "SQLITE_CONSTRAINT_UNIQUE",
      ].includes(String(value)),
    )
  ) {
    return true;
  }
  return /(?:NOT NULL|UNIQUE) constraint failed/.test(error.message);
}
